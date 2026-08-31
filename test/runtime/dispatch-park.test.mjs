// corr-d4: dispatch-time script failures park the run (invocation "waiting")
// instead of stranding it at a leaf where workflow_retry refuses and delivery
// skips. The apply-failure exit shares the same park helper but guards an
// internal invariant that processLeafAt already enforces, so it is unreachable
// through the public API and is covered structurally rather than end-to-end.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { fencePath } from "../../src/runtime/fence.ts";
import { cp, script, task, workflow } from "../engine/helpers.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "park-dispatch-"));
  roots.push(root);
  return root;
}

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
    sendUserMessage: async (message, deliverAs) => {
      sent.push({ message, deliverAs });
    },
  };
  const ctx = {
    ui: {
      status: undefined,
      notices: [],
      setStatus: (id, value) => {
        ctx.ui.status = value;
      },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "park-dispatch-store-"));
  roots.push(storeRoot);
  return { pi, ctx, sent, entries, read, storeRoot };
}

async function settle(runtime, ctx) {
  await runtime.handleAgentSettled(ctx);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}

test("an input resolution failure parks the run and delivers retry guidance", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("go", { inputs: { data: { from: "frame", select: "/data/nope" } } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "t");
  assert.ok(run);
  await runtime.handleAgentSettled(h.ctx);
  const key = runtime.state.execution.stack.at(-1).key;
  await runtime.transition({ status: "completed", key, met: ["framed"], checkpoint: cp("framed the work", { other: 1 }) }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);

  assert.equal(runtime.state.execution.stack.at(-1).key, "root/go", "the run sits at the script leaf");
  assert.equal(runtime.state.status, "active", "the run stays active");
  assert.equal(
    runtime.state.execution.invocations?.["root/go"]?.status,
    "waiting",
    "the dispatch failure parks the leaf as a waiting invocation",
  );
  const notice = h.ctx.ui.notices.at(-1).message;
  assert.match(notice, /could not run: input "data"/, "the failure detail reaches the user");
  assert.match(notice, /parked at .*go/, "the notice names the park");
  const delivered = h.sent.at(-1)?.message ?? "";
  assert.match(delivered, /root\/go/, "the park is delivered to the model");
  assert.match(delivered, /workflow_retry/, "the delivery carries retry guidance");
});

test("workflow_retry re-dispatches a dispatch-parked run and parks again", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("go", { inputs: { data: { from: "frame", select: "/data/nope" } } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "t");
  await runtime.handleAgentSettled(h.ctx);
  const key = runtime.state.execution.stack.at(-1).key;
  await runtime.transition({ status: "completed", key, met: ["framed"], checkpoint: cp("framed the work", { other: 1 }) }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);

  const result = await runtime.retry(undefined, h.ctx);
  assert.equal(result.isError, undefined, "workflow_retry accepts the dispatch-parked run");
  assert.equal(result.details?.status, "parked", "the retried dispatch fails again and re-parks");
  assert.equal(runtime.state.execution.invocations?.["root/go"]?.attempt, 2, "the retry bumps the attempt");
  assert.equal(runtime.state.execution.stack.at(-1).key, "root/go", "the run stays at the script leaf");
});

test("the dispatch-failure park commits no snapshot", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("go", { inputs: { data: { from: "frame", select: "/data/nope" } } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "t");
  await runtime.handleAgentSettled(h.ctx);
  const key = runtime.state.execution.stack.at(-1).key;
  await runtime.transition({ status: "completed", key, met: ["framed"], checkpoint: cp("framed the work", { other: 1 }) }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);

  const activeSnapshots = () => h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active");
  const before = activeSnapshots().length;
  assert.equal(
    activeSnapshots().at(-1).data.execution.invocations?.["root/go"]?.status,
    "running",
    "the park itself is in-memory only: the last snapshot still records the pre-dispatch running state",
  );
  await runtime.retry(undefined, h.ctx);
  assert.equal(activeSnapshots().length, before + 1, "only retry's own commit persists; the re-park adds none");
  assert.equal(
    activeSnapshots().at(-1).data.execution.invocations?.["root/go"]?.attempt,
    1,
    "the re-park (attempt 2) was not committed",
  );
});

test("a live fence parks a restored running script leaf", async () => {
  const root = tempDir();
  const wf = workflow(
    [script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })],
    { overviewPath: join(root, "WORKFLOW.md") },
  );
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(runtime.state.execution.invocations?.["root/stuck"]?.status, "waiting", "the first failure parks the run");

  const revivedHarness = harness();
  revivedHarness.entries.push(...h.entries);
  // Simulate the crash window: the park snapshot is undelivered and the leaf
  // invocation is still recorded "running", so restore re-dispatches it.
  const markerIndex = revivedHarness.entries.findLastIndex((entry) => entry.customType === "choreograph" && entry.data.kind === "delivered");
  if (markerIndex !== -1) revivedHarness.entries.splice(markerIndex, 1);
  const last = revivedHarness.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active").at(-1);
  last.data = structuredClone(last.data);
  last.data.delivered = false;
  last.data.execution.invocations["root/stuck"] = { ...last.data.execution.invocations["root/stuck"], status: "running" };
  const fence = fencePath(root, "root/stuck");
  rmSync(fence, { force: true });
  mkdirSync(join(root, ".choreograph", "fences"), { recursive: true });
  writeFileSync(fence, `${JSON.stringify({ pid: process.pid, attempt: 1, startedAt: Date.now() })}\n`, "utf8");
  try {
    const revived = new RuntimeCoordinator(revivedHarness.pi, [wf], revivedHarness.read, revivedHarness.storeRoot);
    revived.handleSessionStart(revivedHarness.ctx);
    await settle(revived, revivedHarness);
    assert.equal(
      revived.state.execution.invocations?.["root/stuck"]?.status,
      "waiting",
      "the fence-alive dispatch failure parks the leaf",
    );
    const notice = revivedHarness.ctx.ui.notices.map((entry) => entry.message).join("\n");
    assert.match(notice, /still running in another process/, "the fence detail reaches the user");
    assert.match(revivedHarness.sent.at(-1)?.message ?? "", /workflow_retry/, "the park delivers retry guidance");
  } finally {
    rmSync(fence, { force: true });
  }
});

test("a stdin-budget dispatch failure parks the run", async () => {
  const h = harness();
  const blob = "x".repeat(14_000);
  const wf = workflow([
    task("a1", { done: ["a1"] }),
    task("a2", { done: ["a2"] }),
    script("go", { inputs: { first: { from: "a1", select: "/data" }, second: { from: "a2", select: "/data" } } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  for (const [id, met] of [["root/a1", ["a1"]], ["root/a2", ["a2"]]]) {
    await runtime.handleAgentSettled(h.ctx);
    const key = runtime.state.execution.stack.at(-1).key;
    assert.equal(key, id, `the run sits at ${id}`);
    await runtime.transition({ status: "completed", key, met, checkpoint: cp(`${id} done`, { data: blob }) }, undefined, h.ctx);
    await runtime.handleAgentSettled(h.ctx);
  }

  assert.equal(runtime.state.execution.stack.at(-1).key, "root/go", "the run sits at the script leaf");
  assert.equal(
    runtime.state.execution.invocations?.["root/go"]?.status,
    "waiting",
    "the stdin-budget failure parks the leaf as a waiting invocation",
  );
  const notice = h.ctx.ui.notices.at(-1).message;
  assert.match(notice, /stdin budget/, "the failure detail reaches the user");
  assert.match(h.sent.at(-1)?.message ?? "", /workflow_retry/, "the park delivers retry guidance");

  const result = await runtime.retry(undefined, h.ctx);
  assert.equal(result.details?.status, "parked", "workflow_retry accepts the parked run");
});

test("an engine-parked run still delivers the parked guidance after rewording", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(runtime.state.execution.invocations?.["root/stuck"]?.status, "waiting", "the engine park persists");
  const delivered = h.sent.at(-1)?.message ?? "";
  assert.match(delivered, /the run is parked here/, "the delivered guidance states the park");
  assert.match(delivered, /workflow_retry/, "the delivered guidance names the retry tool");
});
