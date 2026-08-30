import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { cp, task, workflow } from "../engine/helpers.mjs";

function harness(options = {}) {
  const sent = [];
  const entries = [];
  const state = { failing: false };
  const pi = {
    getActiveTools: () => ["read", "bash"],
    getAllTools: undefined,
    setActiveTools: () => {},
    appendEntry: (type, data) => {
      if (state.failing) throw new Error("disk full");
      entries.push({ type: "custom", customType: type, data });
    },
    sendUserMessage: async (message) => sent.push(message),
  };
  const ctx = {
    ui: { status: undefined, notices: [], setStatus: () => {}, notify: (message, level) => ctx.ui.notices.push({ message, level }) },
    sessionManager: { getBranch: () => entries },
  };
  if (options.rolloverHost) {
    ctx.sessionManager.getSessionDir = () => storeRoot;
    ctx.sessionManager.getSessionFile = () => join(storeRoot, "parent.json");
  }
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-evict-"));
  return { pi, ctx, sent, entries, state, read, storeRoot };
}

// artifactStores and artifactStoreFor are TS-private; these tests are the report's
// map-size churn assertions, read through the runtime object (type privacy is
// compile-time only), so no production surface widens for tests.
function storeCount(runtime) {
  return runtime.artifactStores.size;
}

test("a completed run releases its artifact store entry (fx3)", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["framed"] })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  const run = await runtime.startWorkflow(h.ctx, wf, "t");
  const runId = run.execution.runId;
  assert.equal(storeCount(runtime), 1, "precondition: the active run holds one store entry");
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.equal(storeCount(runtime), 0, "terminal completion must release the entry");

  const recreated = runtime.artifactStoreFor(wf, runId);
  assert.equal(storeCount(runtime), 1, "a later lookup for the terminal run simply re-creates a store");
  const ref = recreated.publishText("log", "frame", "hello");
  const materialized = recreated.materialize(ref, h.storeRoot);
  assert.ok(materialized.ok, "the re-created store still materializes (content addressing)");
});

test("an aborted run releases its artifact store entry (fx3)", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["framed"] })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  await runtime.startWorkflow(h.ctx, wf, "t");
  assert.equal(storeCount(runtime), 1);
  await runtime.abort(undefined, h.ctx);
  assert.equal(storeCount(runtime), 0, "terminal abort must release the entry");
});

test("a mid-run rollover keeps the entry; the runId persists across the session roll (fx3)", async () => {
  const h = harness({ rolloverHost: true });
  const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  const run = await runtime.startWorkflow(h.ctx, wf, "t");
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.equal(result.details.status, "rollover-pending", "precondition: the advance rolled to a fresh session");
  assert.equal(storeCount(runtime), 1, "rollover is not terminal: the entry stays");
  assert.ok(runtime.artifactStores.has(run.execution.runId), "the entry is keyed by the persisting runId");
});

test("completion rollover releases the entry once the terminal transfer is prepared (fx3)", async () => {
  const h = harness({ rolloverHost: true });
  const wf = workflow([task("frame", { done: ["framed"] })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  await runtime.startWorkflow(h.ctx, wf, "t");
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.equal(result.details.status, "rollover-pending");
  assert.equal(storeCount(runtime), 0, "the completed rollover path is terminal");
});

test("a failed completion rollover keeps the entry until the run is truly terminal (fx3)", async () => {
  const h = harness({ rolloverHost: true });
  const wf = workflow([task("frame", { done: ["framed"] })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  await runtime.startWorkflow(h.ctx, wf, "t");
  h.state.failing = true;
  const failed = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.equal(failed.details.status, "rollover-failed");
  assert.equal(storeCount(runtime), 1, "the run can retry, so the entry stays");
  h.state.failing = false;
  const retried = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.equal(retried.details.status, "rollover-pending");
  assert.equal(storeCount(runtime), 0, "the successful terminal transition releases the entry");
});
