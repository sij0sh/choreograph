import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator, WorkflowCompileError } from "../../src/runtime/coordinator.ts";
import { loadWorkflowManifest } from "../../src/authoring/parser.ts";
import { SNAPSHOT_TYPE } from "../../src/persistence/snapshot.ts";

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

function workflowDir(name) {
  const root = mkdtempSync(join(tmpdir(), "cc-"));
  const dir = join(root, name);
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "WORKFLOW.md"), `---\ndescription: probe.\nsteps:\n  - id: frame\n    run: steps/frame.md\n---\n# Overview\n`);
  writeFileSync(join(dir, "steps", "frame.md"), "# Frame instructions\n");
  return dir;
}

test("startWorkflow refuses when a required instruction file is unreadable on the real filesystem", async () => {
  const dir = workflowDir("refuse-start");
  const wf = loadWorkflowManifest(dir);
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf]);

  unlinkSync(join(dir, "steps", "frame.md"));

  await assert.rejects(
    () => runtime.startWorkflow(h.ctx, wf, "t"),
    (error) => {
      assert.ok(error instanceof WorkflowCompileError, `expected WorkflowCompileError, got ${error?.name}`);
      assert.match(error.message, /steps[\\/]frame\.md/);
      assert.match(error.message, /did not start/);
      return true;
    },
  );
  assert.equal(h.sent.length, 0, "no first message may be delivered for a refused run");
  assert.ok(!h.entries.some((entry) => entry.customType === SNAPSHOT_TYPE), "no run snapshot may be persisted for a refused run");

  writeFileSync(join(dir, "steps", "frame.md"), "# Frame instructions\n");
  const run = await runtime.startWorkflow(h.ctx, wf, "recovered");
  assert.ok(run, "startWorkflow succeeds again once the file is restored");
  rmSync(dir, { recursive: true, force: true });
});

test("restoreRun refuses to resume when the definition no longer compiles", async () => {
  const dir = workflowDir("refuse-restore");
  const wf = loadWorkflowManifest(dir);
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf]);
  await runtime.startWorkflow(h.ctx, wf, "t");
  assert.ok(h.entries.some((entry) => entry.customType === SNAPSHOT_TYPE), "precondition: the run persisted a snapshot");
  const sentBeforeRestore = h.sent.length;

  unlinkSync(join(dir, "steps", "frame.md"));

  const notices = [];
  const ctx = { ...h.ctx, ui: { ...h.ctx.ui, notify: (message) => notices.push(message) } };
  const resumed = new RuntimeCoordinator(h.pi, [wf]);
  resumed.restoreRun(ctx);

  assert.ok(notices.some((message) => /Cannot resume/.test(message) && /no longer compiles/.test(message) && /not readable/.test(message)), `expected a resume refusal notice, got ${JSON.stringify(notices)}`);
  assert.equal(h.sent.length, sentBeforeRestore, "a refused resume must not deliver messages");
  rmSync(dir, { recursive: true, force: true });
});
