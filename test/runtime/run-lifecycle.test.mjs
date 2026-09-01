import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { activeSnapshot, pausedMarker, pausedSnapshot, parseSnapshot, SNAPSHOT_TYPE } from "../../src/persistence/snapshot.ts";
import { latestSnapshot } from "../../src/persistence/store.ts";
import { task, workflow } from "../engine/helpers.mjs";
import { lifecycleRoles, RUN_LIFECYCLE_STATUSES } from "../../src/domain/run.ts";

function harness() {
  const sent = [];
  const entries = [];
  const activeTools = new Set(["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, deliverAs) => sent.push({ message, deliverAs }),
  };
  const ctx = {
    ui: {
      notices: [],
      setStatus: () => {},
      setWidget: () => {},
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  return { pi, ctx, sent, entries, activeTools };
}

const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
const read = () => "# instructions";
const root = () => mkdtempSync(join(tmpdir(), "pwf-lc-"));

test("a paused run round-trips: persist, restore paused, resume, complete", async () => {
  const h = harness();
  const store = root();
  const runtime = new RuntimeCoordinator(h.pi, [wf], read, store);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(runtime.state.status, "active");

  // The pause marker is the persisted park; a restart must honor it.
  h.entries.push({ type: "custom", customType: SNAPSHOT_TYPE, data: pausedMarker(runtime.state.execution.runId) });

  const restarted = new RuntimeCoordinator(h.pi, [wf], read, store);
  restarted.handleSessionStart(h.ctx);
  assert.equal(restarted.state.status, "paused", "restore honors the pause marker");
  assert.ok(!h.activeTools.has("workflow_transition"), "transition is hidden while paused");
  assert.ok(!h.activeTools.has("workflow_retry"), "retry is hidden while paused");
  assert.ok(h.activeTools.has("workflow_abort"), "abort stays available while paused");
  await assert.rejects(
    () => restarted.transition({ key: restarted.state.execution.stack.at(-1)?.key, status: "completed", checkpoint: { summary: "x" } }, undefined, h.ctx),
    /paused/,
    "transition refuses a paused run",
  );

  await restarted.resumePaused(h.ctx);
  assert.equal(restarted.state.status, "active", "resume returns the run to active");
  await restarted.transition(
    { key: restarted.state.execution.stack.at(-1)?.key, status: "completed", checkpoint: { summary: "framed" }, met: ["framed"] },
    undefined,
    h.ctx,
  );
  const outcome = await restarted.transition(
    { key: restarted.state.execution.stack.at(-1)?.key, status: "completed", checkpoint: { summary: "delivered" } },
    undefined,
    h.ctx,
  );
  assert.equal(outcome.details.status, "completed");
  assert.equal(restarted.state.status, "idle");
});

test("a paused run aborts instead of resuming", async () => {
  const h = harness();
  const store = root();
  const runtime = new RuntimeCoordinator(h.pi, [wf], read, store);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  h.entries.push({ type: "custom", customType: SNAPSHOT_TYPE, data: pausedMarker(runtime.state.execution.runId) });

  const restarted = new RuntimeCoordinator(h.pi, [wf], read, store);
  restarted.handleSessionStart(h.ctx);
  assert.equal(restarted.state.status, "paused");
  const result = await restarted.abort(undefined, h.ctx);
  assert.equal(result.details.status, "aborted", "a paused run is abortable");
  assert.equal(restarted.state.status, "idle");
});

test("resume refuses when the resume snapshot cannot commit", async () => {
  const h = harness();
  const store = root();
  const runtime = new RuntimeCoordinator(h.pi, [wf], read, store);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const execution = structuredClone(runtime.state.execution);
  h.entries.length = 0;
  h.entries.push({ type: "custom", customType: SNAPSHOT_TYPE, data: pausedSnapshot({ workflow: wf.name, execution, delivered: false }) });
  const restarted = new RuntimeCoordinator(h.pi, [wf], read, store);
  restarted.handleSessionStart(h.ctx);
  assert.equal(restarted.state.status, "paused", "a full paused record restores paused");
  h.pi.appendEntry = () => {
    throw new Error("session storage is full");
  };
  await restarted.resumePaused(h.ctx);
  assert.equal(restarted.state.status, "paused", "the run stays paused when the commit refuses");
  assert.ok(h.ctx.ui.notices.some((n) => n.level === "error" && /Cannot resume/.test(n.message)));
});

test("paused snapshots and markers decode through the owned paths", () => {
  const execution = { workflowName: "demo", runId: "r1", target: "", status: "active", stack: [{ kind: "task", blockId: "frame", key: "root/frame", attempt: 1 }], checkpoints: {}, checkpointOrder: [], plans: {}, loops: {} };
  const record = pausedSnapshot({ workflow: "demo", execution, delivered: false });
  const parsed = parseSnapshot(record);
  assert.equal(parsed.status, "paused");
  assert.equal(parsed.execution.runId, "r1");
  const folded = latestSnapshot([
    { type: "custom", customType: SNAPSHOT_TYPE, data: activeSnapshot({ workflow: "demo", execution: record.execution, delivered: false }) },
    { type: "custom", customType: SNAPSHOT_TYPE, data: { v: 1, kind: "delivered", runId: "r1" } },
    { type: "custom", customType: SNAPSHOT_TYPE, data: pausedMarker("r1") },
  ]);
  assert.equal(folded.status, "paused", "the marker folds the active snapshot into a paused record");
  assert.equal(folded.delivered, true, "the delivered tombstone still folds");
  assert.equal(latestSnapshot([{ type: "custom", customType: SNAPSHOT_TYPE, data: pausedMarker("r2") }]), null);
});

test("the widget view renders paused", async () => {
  const { buildWorkflowView } = await import("../../src/runtime/workflow-ui.ts");
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf], read, root());
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const execution = runtime.state.execution;
  assert.equal(buildWorkflowView(wf, execution)?.state, "running");
  assert.equal(buildWorkflowView(wf, execution, "paused")?.state, "paused");
});

test("the owned lifecycle table answers live and abortable", () => {
  assert.deepEqual([...RUN_LIFECYCLE_STATUSES], ["active", "paused", "completed", "aborted"]);
  assert.deepEqual(lifecycleRoles("active"), { live: true, abortable: true });
  assert.deepEqual(lifecycleRoles("paused"), { live: false, abortable: true });
  assert.deepEqual(lifecycleRoles("completed"), { live: false, abortable: false });
  assert.deepEqual(lifecycleRoles("aborted"), { live: false, abortable: false });
});
