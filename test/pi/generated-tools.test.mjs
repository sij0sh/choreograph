import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { registerWorkflowTools } from "../../src/pi/tools.ts";
import { discoverWorkflows } from "../../src/authoring/parser.ts";
import { workflow, task, completed, cp } from "../engine/helpers.mjs";

function harness(options = {}) {
  const tools = new Map();
  const sent = [];
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: (names) => {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, deliverAs) => sent.push({ message, deliverAs }),
  };
  const ctx = {
    ui: {
      notices: [],
      setStatus: () => {},
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const workflowsRoot = options.workflowsRoot ?? mkdtempSync(join(tmpdir(), "promote-tools-"));
  const runtime = new RuntimeCoordinator(pi, options.workflows ?? [], () => "# fallback");
  registerWorkflowTools(pi, runtime, options.workflows ?? [], workflowsRoot);
  return { pi, ctx, tools, sent, entries, activeTools, runtime, workflowsRoot };
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

const RUN = "workflow_run_definition";
const PROMOTE = "workflow_promote";

test("workflow_run_definition starts a validated definition immediately", async () => {
  const h = harness();
  const result = await h.tools.get(RUN).execute("t", { definition: spec(), target: "the demo asset set" }, undefined, undefined, h.ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.terminate, true, "starting ends the turn like workflow_start");
  assert.equal(result.details.status, "active");
  assert.equal(result.details.workflow, "audit-assets");
  assert.match(h.sent[0].message, new RegExp(result.details.runId), "the first control message names the run");
});

test("workflow_run_definition rejects malformed definitions without starting", async () => {
  const h = harness();
  const result = await h.tools.get(RUN).execute("t", { definition: spec({ name: "Bad_Name" }) }, undefined, undefined, h.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "definition-invalid");
  assert.match(result.content[0].text, /name must match/);
  assert.equal(h.entries.length, 0, "nothing was persisted");
});

test("workflow_run_definition refuses busy sessions and discovered-name collisions", async () => {
  const h = harness();
  await h.tools.get(RUN).execute("t", { definition: spec() }, undefined, undefined, h.ctx);
  const second = await h.tools.get(RUN).execute("t", { definition: spec({ name: "other" }) }, undefined, undefined, h.ctx);
  assert.equal(second.isError, true);
  assert.equal(second.details.status, "busy");

  const busy = harness({ workflows: [workflow([task("only")], { name: "demo", piVisibility: true })] });
  const collision = await busy.tools.get(RUN).execute("t", { definition: spec({ name: "demo" }) }, undefined, undefined, busy.ctx);
  assert.equal(collision.isError, true);
  assert.equal(collision.details.status, "definition-invalid");
  assert.match(collision.content[0].text, /already used by a discovered workflow/);
});

test("workflow_promote persists a started definition into the workflows root", async () => {
  const h = harness();
  await h.tools.get(RUN).execute("t", { definition: spec() }, undefined, undefined, h.ctx);
  const promoted = await h.tools.get(PROMOTE).execute("t", { name: "audit-assets" }, undefined, undefined, h.ctx);
  assert.equal(promoted.isError, undefined);
  assert.equal(promoted.details.status, "promoted");
  assert.match(promoted.content[0].text, /audit-assets/);
  const directory = promoted.details.directory;
  assert.ok(existsSync(join(directory, "WORKFLOW.md")));
  assert.match(readFileSync(join(directory, "steps", "scan.md"), "utf8"), /# Scan assets/);
  const discovered = discoverWorkflows(h.workflowsRoot);
  assert.deepEqual(discovered.workflows.map((entry) => entry.name), ["audit-assets"]);
});

test("workflow_promote refuses unknown names and repeated promotion", async () => {
  const h = harness();
  await h.tools.get(RUN).execute("t", { definition: spec() }, undefined, undefined, h.ctx);
  const unknown = await h.tools.get(PROMOTE).execute("t", { name: "nope" }, undefined, undefined, h.ctx);
  assert.equal(unknown.isError, true);
  assert.equal(unknown.details.status, "promote-failed");
  assert.match(unknown.content[0].text, /no generated workflow/);
  const first = await h.tools.get(PROMOTE).execute("t", { name: "audit-assets" }, undefined, undefined, h.ctx);
  assert.equal(first.isError, undefined);
  const again = await h.tools.get(PROMOTE).execute("t", { name: "audit-assets" }, undefined, undefined, h.ctx);
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /already exists/);
});

test("run-definition and promote are idle-only and excluded from the baseline", async () => {
  const h = harness();
  h.runtime.handleSessionStart(h.ctx);
  assert.ok(h.activeTools.has(RUN));
  assert.ok(h.activeTools.has(PROMOTE));
  assert.ok(!h.activeTools.has("workflow_start"), "no visible workflows means no start tool");

  await h.tools.get(RUN).execute("t", { definition: spec() }, undefined, undefined, h.ctx);
  assert.ok(!h.activeTools.has(RUN), "run-definition disappears while a run is active");
  assert.ok(!h.activeTools.has(PROMOTE), "promote disappears while a run is active");
  assert.ok(h.activeTools.has("workflow_transition"));

  await h.runtime.transition(completed(cp("scanned")), undefined, h.ctx);
  await h.runtime.handleAgentSettled(h.ctx);
  await h.runtime.transition(completed(cp("reported"), ["scan"]), undefined, h.ctx);
  await h.runtime.handleAgentSettled(h.ctx);
  assert.ok(h.activeTools.has(RUN), "the tools return once the run completes");
  assert.ok(h.activeTools.has(PROMOTE));
});
