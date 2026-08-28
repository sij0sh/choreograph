import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { readBlockFrom } from "../../src/runtime/prompts.ts";
import { parseDefinitionSpec, buildGeneratedWorkflow, DEFINITIONS_ENTRY_TYPE } from "../../src/authoring/generated.ts";
import { discoverWorkflows, loadWorkflowManifest } from "../../src/authoring/parser.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";

function harness(options = {}) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    getAllTools: undefined,
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(names));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, deliverAs) => sent.push({ message, deliverAs }),
  };
  const ctx = {
    ui: {
      status: undefined,
      notices: [],
      setStatus: (id, value) => { ctx.ui.status = value; },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  return { pi, ctx, sent, entries, activeTools };
}

function spec(overrides = {}) {
  return {
    name: "audit-assets",
    description: "Check project assets for problems.",
    steps: [
      { id: "scan", instruction: "# Scan assets\nList every asset with issues." },
      { id: "report", instruction: "# Report\nSummarize the findings.", done: ["scan"] },
    ],
    ...overrides,
  };
}

function definitionsOf(entries) {
  return entries.filter((entry) => entry.customType === DEFINITIONS_ENTRY_TYPE).map((entry) => entry.data);
}

test("spec validation rejects malformed definitions", () => {
  assert.throws(() => parseDefinitionSpec({ ...spec(), name: "Bad_Name" }), /name must match/);
  assert.throws(() => parseDefinitionSpec({ ...spec(), extra: 1 }), /unknown definition key/);
  assert.throws(() => parseDefinitionSpec({ ...spec(), steps: [] }), /non-empty list/);
  assert.throws(() => parseDefinitionSpec({
    ...spec(),
    steps: [{ id: "same", instruction: "a" }, { id: "same", instruction: "b" }],
  }), /already used/);
  assert.throws(() => parseDefinitionSpec(spec({ steps: [{ id: "step", instruction: "" }] })), /non-empty string/);
  assert.throws(() => parseDefinitionSpec({
    ...spec(),
    steps: [{ id: "step", instruction: "work", done: [] }],
  }), /non-empty list/);
  assert.doesNotThrow(() => parseDefinitionSpec({
    ...spec(),
    steps: [{ id: "step", instruction: "work", done: ["any-criterion-id"] }],
  }), "done criteria are free-form ids, not step references");
});

test("compiled digest is stable and instruction-sensitive", () => {
  const first = buildGeneratedWorkflow(parseDefinitionSpec(spec()));
  const second = buildGeneratedWorkflow(parseDefinitionSpec(spec()));
  assert.equal(first.compiled.digest, second.compiled.digest);
  const changed = spec();
  changed.steps[0] = { ...changed.steps[0], instruction: "# Scan assets\nDifferent text." };
  const third = buildGeneratedWorkflow(parseDefinitionSpec(changed));
  assert.notEqual(first.compiled.digest, third.compiled.digest);
});

test("a generated definition runs start to completion with in-memory instructions", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [], () => "# fallback");
  const run = await runtime.startGenerated(spec(), "the demo asset set", h.ctx);
  assert.ok(run, "the run starts");
  const runId = run.execution.runId;
  assert.match(h.sent[0].message, new RegExp(runId), "the control message names the run");
  const guide = runtime.handleBeforeAgentStart({ systemPrompt: "base" }).systemPrompt;
  assert.match(guide, /# Scan assets/, "the first instruction renders from memory");
  await runtime.transition(completed(cp("scanned"), []), undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const guide2 = runtime.handleBeforeAgentStart({ systemPrompt: "base" }).systemPrompt;
  assert.match(guide2, /# Report/, "the second instruction renders after the first step");
  await runtime.transition(completed(cp("reported"), ["scan"]), undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const snapshots = h.entries.filter((entry) => entry.customType === "choreograph");
  const last = snapshots[snapshots.length - 1].data;
  assert.equal(last.status, "completed");
  assert.equal(last.workflow, "audit-assets");
  assert.ok(last.runId.startsWith(runId) || last.runId === runId);
  assert.ok(h.sent.some((item) => /is complete/.test(item.message)), "a summary request follows completion");
});

test("generated runs persist a definition entry and restore in a fresh session", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [], () => "# fallback");
  await runtime.startGenerated(spec(), "target", h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition(completed(cp("scanned"), []), undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  assert.equal(definitionsOf(h.entries).length, 1, "one definition entry was appended");
  assert.equal(definitionsOf(h.entries)[0].name, "audit-assets");

  const restoredHarness = harness();
  restoredHarness.entries.push(...h.entries);
  const restored = new RuntimeCoordinator(restoredHarness.pi, [], () => "# fallback");
  restored.handleSessionStart(restoredHarness.ctx);
  assert.ok(
    restoredHarness.ctx.ui.notices.some((notice) => /Resumed Audit Assets run/.test(notice.message)),
    "the run resumes from the replayed definition",
  );
  const guide = restored.handleBeforeAgentStart({ systemPrompt: "base" }).systemPrompt;
  assert.match(guide, /# Report/, "the restored run renders instructions from the replayed definition");
  const result = await restored.transition(completed(cp("reported"), ["scan"]), undefined, restoredHarness.ctx);
  assert.equal(result.details.status, "completed");
});

test("a restored generated run refuses a changed definition instead of resuming", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [], () => "# fallback");
  await runtime.startGenerated(spec(), "target", h.ctx);
  await runtime.handleAgentSettled(h.ctx);

  const tampered = harness();
  for (const entry of h.entries) {
    if (entry.customType !== DEFINITIONS_ENTRY_TYPE) {
      tampered.entries.push(entry);
      continue;
    }
    tampered.entries.push({ type: "custom", customType: DEFINITIONS_ENTRY_TYPE, data: spec({ steps: [{ id: "scan", instruction: "rewritten" }] }) });
  }
  const restored = new RuntimeCoordinator(tampered.pi, [], () => "# fallback");
  restored.handleSessionStart(tampered.ctx);
  assert.ok(
    tampered.ctx.ui.notices.some((notice) => /digest mismatch/.test(notice.message)),
    "the run is dropped with a digest mismatch warning",
  );
});

test("generated names may not collide with discovered workflows and busy sessions refuse starts", async () => {
  const h = harness();
  const discovered = workflow([task("only")], { name: "demo", piVisibility: true });
  const runtime = new RuntimeCoordinator(h.pi, [discovered], () => "# fallback");
  await assert.rejects(() => runtime.startGenerated(spec({ name: "demo" }), "", h.ctx), /already used by a discovered workflow/);
  const run = await runtime.startGenerated(spec(), "", h.ctx);
  assert.ok(run);
  const second = await runtime.startGenerated(spec({ name: "other" }), "", h.ctx);
  assert.equal(second, null, "a second start is refused while one is active");
  assert.ok(h.ctx.ui.notices.some((notice) => /already active/.test(notice.message)));
});

test("promotion persists a generated definition as a discoverable workflow", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [], () => "# fallback");
  await runtime.startGenerated(spec(), "target", h.ctx);
  const root = mkdtempSync(join(tmpdir(), "promote-"));
  const { directory } = runtime.promoteDefinition("audit-assets", root);
  assert.ok(existsSync(join(directory, "WORKFLOW.md")));
  const manifest = loadWorkflowManifest(directory);
  assert.equal(manifest.name, "audit-assets");
  assert.equal(manifest.root.children.map((child) => child.id).join(","), "scan,report");
  const discovered = discoverWorkflows(root);
  assert.deepEqual(discovered.workflows.map((workflow_) => workflow_.name), ["audit-assets"]);
  assert.ok(readdirSync(join(directory, "steps")).includes("scan.md"));

  // Disproof attempt: the promoted workflow must run as a discovered
  // workflow in a fresh session, not merely parse.
  const freshHarness = harness();
  const fresh = new RuntimeCoordinator(freshHarness.pi, discovered.workflows, readBlockFrom({ readFileSync }));
  const promotedRun = await fresh.startWorkflow(freshHarness.ctx, discovered.workflows[0], "assets", undefined);
  assert.ok(promotedRun, "the promoted workflow starts");
  await fresh.transition(completed(cp("promoted-scan")), undefined, freshHarness.ctx);
  await fresh.handleAgentSettled(freshHarness.ctx);
  const finalGuide = fresh.handleBeforeAgentStart({ systemPrompt: "base" }).systemPrompt;
  assert.match(finalGuide, /# Report/, "the promoted workflow serves file-backed instructions");
});

test("promotion refuses unknown names, collisions, and overwrites", async () => {
  const h = harness();
  const discovered = workflow([task("only")], { name: "demo" });
  const runtime = new RuntimeCoordinator(h.pi, [discovered], () => "# fallback");
  await runtime.startGenerated(spec(), "target", h.ctx);
  const root = mkdtempSync(join(tmpdir(), "promote-"));
  assert.throws(() => runtime.promoteDefinition("nope", root), /no generated workflow/);
  assert.throws(() => runtime.promoteDefinition("demo", root), /already a discovered workflow/);
  const { directory } = runtime.promoteDefinition("audit-assets", root);
  assert.ok(existsSync(directory), "the first promotion lands");
  assert.throws(() => runtime.promoteDefinition("audit-assets", root), /already exists/, "overwrite is refused");
  const manifest = loadWorkflowManifest(directory);
  assert.equal(manifest.root.children.map((child) => child.id).join(","), "scan,report");
});
