import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { cp, task, workflow } from "../engine/helpers.mjs";
import { LIMITS } from "../../src/domain/limits.ts";

/** Harness without rollover support: finishRun takes the plain commit path. */
function harness() {
  const sent = [];
  const entries = [];
  const state = { failAppend: undefined };
  const pi = {
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => {},
    appendEntry: (type, data) => {
      if (state.failAppend) throw state.failAppend;
      entries.push({ type: "custom", customType: type, data });
    },
    sendUserMessage: async (message) => sent.push(message),
  };
  const ctx = {
    ui: { notices: [], setStatus() {}, notify: (message, level) => ctx.ui.notices.push({ message, level }) },
    // No sessionManager: supportsSessionRollover(ctx) is false.
  };
  const storeRoot = mkdtempSync(join(tmpdir(), "stop-local-"));
  return { pi, ctx, sent, entries, state, storeRoot };
}

const startedRuntime = async (h) => {
  const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# instructions", h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  return runtime;
};

test("a failed abort stops the run locally and rejects later dispatch (corr-c10)", async () => {
  const h = harness();
  const runtime = await startedRuntime(h);
  h.state.failAppend = new Error("disk full");
  const result = await runtime.abort(undefined, h.ctx);
  assert.ok(result.isError);
  assert.equal(result.details.status, "storage-failed");
  assert.match(result.content[0].text, /stopped locally/);
  assert.equal(runtime.state.status, "idle", "nothing stays dispatchable after a failed abort");
  await assert.rejects(
    () => runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("x") }, undefined, h.ctx),
    /no active workflow/,
  );
  rmSync(h.storeRoot, { recursive: true, force: true });
});

test("a failed abort at the snapshot cap stops the run locally too (corr-c10)", async () => {
  const h = harness();
  const runtime = await startedRuntime(h);
  const originalCap = LIMITS.snapshotEntriesPerSession;
  LIMITS.snapshotEntriesPerSession = 0;
  try {
    const result = await runtime.abort(undefined, h.ctx);
    assert.ok(result.isError);
    assert.equal(result.details.status, "snapshot-cap");
    assert.match(result.content[0].text, /stopped locally/);
    assert.equal(runtime.state.status, "idle");
  } finally {
    LIMITS.snapshotEntriesPerSession = originalCap;
  }
  rmSync(h.storeRoot, { recursive: true, force: true });
});

test("a failed completed-run commit stays retryable (corr-c10 regression)", async () => {
  const h = harness();
  const runtime = await startedRuntime(h);
  const first = await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!first.isError, first.content[0].text);
  await runtime.handleAgentSettled(h.ctx);

  h.state.failAppend = new Error("append broke");
  const failed = await runtime.transition({ key: "root/deliver", status: "completed", checkpoint: cp("delivered") }, undefined, h.ctx);
  assert.ok(failed.isError);
  assert.match(failed.details.status, /storage-failed/);
  assert.match(failed.content[0].text, /stays active/);
  assert.equal(runtime.state.status, "active", "a failed completion keeps the run retryable");

  h.state.failAppend = undefined;
  const retried = await runtime.transition({ key: "root/deliver", status: "completed", checkpoint: cp("delivered") }, undefined, h.ctx);
  assert.ok(!retried.isError, retried.content[0].text);
  assert.equal(runtime.state.status, "idle");
  rmSync(h.storeRoot, { recursive: true, force: true });
});
