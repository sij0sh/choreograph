import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { loadWorkflowManifest } from "../../src/authoring/parser.ts";
import { buildGeneratedWorkflow, parseDefinitionSpec, DEFINITIONS_ENTRY_TYPE } from "../../src/authoring/generated.ts";
import { completed, cp } from "../engine/helpers.mjs";

function harness() {
  const sent = [];
  const entries = [];
  const pi = {
    getActiveTools: () => ["read", "bash"],
    getAllTools: undefined,
    setActiveTools: () => {},
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, deliverAs) => sent.push({ message, deliverAs }),
  };
  const ctx = {
    ui: { status: undefined, notices: [], setStatus: () => {}, notify: () => {} },
    sessionManager: { getBranch: () => entries },
  };
  return { pi, ctx, sent, entries };
}

function workflowDir(name, stepText) {
  const root = mkdtempSync(join(tmpdir(), "pf-"));
  const dir = join(root, name);
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "WORKFLOW.md"), `---\ndescription: probe.\nsteps:\n  - id: frame\n    run: steps/frame.md\n---\n# Overview v1\n`);
  writeFileSync(join(dir, "steps", "frame.md"), `${stepText}\n`);
  return dir;
}

function promptOf(runtime, ctx) {
  return runtime.handleBeforeAgentStart({ systemPrompt: "BASE" }).systemPrompt;
}


test("task prompts are served from frozen content; a mid-run edit is inert", async () => {
  const dir = workflowDir("freeze-probe", "# Frame v1");
  const wf = loadWorkflowManifest(dir);
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf]);

  await runtime.startWorkflow(h.ctx, wf, "t");
  await runtime.handleAgentSettled(h.ctx);
  const before = promptOf(runtime, h.ctx);
  assert.match(before, /# Frame v1/);
  assert.match(before, /# Overview v1/);

  writeFileSync(join(dir, "steps", "frame.md"), "# Frame EDITED-MID-RUN\n");
  writeFileSync(join(dir, "WORKFLOW.md"), `---\ndescription: probe.\nsteps:\n  - id: frame\n    run: steps/frame.md\n---\n# Overview EDITED-MID-RUN\n`);
  const after = promptOf(runtime, h.ctx);
  assert.equal(after, before, "a mid-run edit must not change the next prompt");
  assert.doesNotMatch(after, /EDITED-MID-RUN/);

});

test("frontmatter is stripped from frozen task instructions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-"));
  const dir = join(root, "fm-probe");
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "WORKFLOW.md"), `---\ndescription: probe.\nsteps:\n  - id: frame\n    run: steps/frame.md\n---\n# Overview\n`);
  writeFileSync(join(dir, "steps", "frame.md"), "---\nignored: meta\n---\n# Frame body\n");
  const wf = loadWorkflowManifest(dir);
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf]);
  await runtime.startWorkflow(h.ctx, wf, "t");
  await runtime.handleAgentSettled(h.ctx);
  assert.match(promptOf(runtime, h.ctx), /# Frame body/);
  assert.doesNotMatch(promptOf(runtime, h.ctx), /ignored: meta/);
});

test("operator prompts are served frozen", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-"));
  const dir = join(root, "op-probe");
  mkdirSync(join(dir, "steps"), { recursive: true });
  mkdirSync(join(dir, "operators"), { recursive: true });
  writeFileSync(join(dir, "operators", "inspect.md"), "---\ndescription: Inspect things.\n---\n# Inspect operator v1\n");
  writeFileSync(join(dir, "operators", "trace.md"), "---\ndescription: Trace things.\n---\n# Trace operator\n");
  writeFileSync(join(dir, "WORKFLOW.md"), `---\ndescription: probe.\nsteps:\n  - id: gather\n    run: steps/frame.md\n  - id: make\n    plan:\n      operators: [inspect, trace]\n---\n# Overview\n`);
  writeFileSync(join(dir, "steps", "frame.md"), "# Frame\n");
  const wf = loadWorkflowManifest(dir);
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf]);
  await runtime.startWorkflow(h.ctx, wf, "t");
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", checkpoint: { summary: "gathered" } }, undefined, h.ctx);
  await runtime.transition({
    status: "completed",
    checkpoint: { summary: "planned", data: { plan: { version: 1, nodes: [
      { id: "a", operator: "inspect", objective: "o", done: ["a-done"] },
      { id: "b", operator: "trace", objective: "o", done: ["b-done"] },
    ] } } },
  }, undefined, h.ctx);
  const prompt = promptOf(runtime, h.ctx);
  assert.match(prompt, /# Inspect operator v1/);
  writeFileSync(join(dir, "operators", "inspect.md"), "---\ndescription: Inspect things.\n---\n# Inspect EDITED-MID-RUN\n");
  assert.equal(promptOf(runtime, h.ctx), prompt, "an operator file edit mid-run must not change the next prompt");
});

test("generated workflows still render from their virtual frozen instructions", async () => {
  const built = buildGeneratedWorkflow(parseDefinitionSpec({
    name: "gen-probe",
    description: "Generated probe.",
    steps: [{ id: "scan", instruction: "# Scan generated\nDo the scan." }],
  }));
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, []);
  await runtime.startGenerated(JSON.parse(JSON.stringify({
    name: "gen-probe",
    description: "Generated probe.",
    steps: [{ id: "scan", instruction: "# Scan generated\nDo the scan." }],
  })), "t", h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const prompt = promptOf(runtime, h.ctx);
  assert.match(prompt, /# Scan generated/);
  assert.ok(built.compiled.digest);
});
