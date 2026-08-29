import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { activeSnapshot } from "../../src/persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../../src/persistence/migrate.ts";
import { completed, cp, loop, memoryStore, task, workflow } from "../engine/helpers.mjs";
import { start, transition } from "../../src/engine/interpreter.ts";
import { LIMITS } from "../../src/domain/limits.ts";

function harness(options = {}) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => {
      if (options.failAppend) throw options.failAppend;
      entries.push({ type: "custom", customType: type, data });
    },
    sendUserMessage: async (message) => {
      if (options.failSend) throw options.failSend;
      sent.push(message);
    },
  };
  const ctx = () => {
    const context = {
      notices: [],
      sessionManager: { getBranch: () => entries },
      models: new Map(),
      model: undefined,
      modelRegistry: undefined,
      setModel: undefined,
    };
    context.ui = { setStatus() {}, notify: (message, level) => context.notices.push({ message, level }) };
    return context;
  };
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-hard-store-"));
  return { pi, sent, entries, activeTools, ctx, storeRoot };
}

const OPERATORS = new Map([
  ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect." }],
  ["trace", { id: "trace", path: "operators/trace.md", description: "Trace." }],
]);

function planWorkflow() {
  return workflow(
    [task("frame"), { kind: "plan", id: "investigate", operators: ["inspect", "trace"] }, task("deliver")],
    { operators: OPERATORS },
  );
}

async function midPlanState() {
  const wf = planWorkflow();
  let state = start(wf, { runId: "run-9" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", { plan: { version: 1, nodes: [
      { id: "probe", operator: "inspect", objective: "o", done: ["probe-done"] },
      { id: "flow", operator: "trace", objective: "o", done: ["flow-done"] },
    ] } })),
  }).state;
  return { wf, state };
}

test("restore drops the run when the workflow was removed", async () => {
  const { wf, state } = await midPlanState();
  const h = harness();
  h.entries.push({ type: "custom", customType: "choreograph", data: activeSnapshot({ workflow: wf.name, execution: state, delivered: true }) });
  const runtime = new RuntimeCoordinator(h.pi, [], () => "# x", h.storeRoot);
  const context = h.ctx();
  runtime.handleSessionStart(context);
  assert.ok(context.notices.some((notice) => /no longer exists/.test(notice.message)));
});

test("restore drops the run when an operator was removed", async () => {
  const { wf, state } = await midPlanState();
  const shrunk = workflow(
    [task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }, task("deliver")],
    { operators: new Map([["inspect", OPERATORS.get("inspect")]]) },
  );
  const migrated = validateAgainstWorkflow(shrunk, state);
  assert.ok(!migrated.ok);
  assert.match(migrated.error, /not trusted/);
});

test("restore drops the run when a task was renamed", async () => {
  const { state } = await midPlanState();
  const renamed = workflow(
    [task("frame-2"), { kind: "plan", id: "investigate", operators: ["inspect", "trace"] }, task("deliver")],
    { operators: OPERATORS },
  );
  const migrated = validateAgainstWorkflow(renamed, state);
  assert.ok(!migrated.ok);
});

test("malformed dynamic plans never resume", async () => {
  const { wf, state } = await midPlanState();
  const forged = structuredClone(state);
  forged.plans["root/investigate"] = {
    ...forged.plans["root/investigate"],
    plan: { version: 1, nodes: [{ id: "evil", operator: "inspect", objective: "no criteria", done: [] }] },
  };
  const migrated = validateAgainstWorkflow(wf, forged);
  assert.ok(!migrated.ok);
});

test("restored plans are re-validated with creation-time semantics", async () => {
  const { wf, state } = await midPlanState();
  const forged = structuredClone(state);
  const plan = forged.plans["root/investigate"];
  forged.plans["root/investigate"] = {
    ...plan,
    plan: { version: 1, nodes: [
      { ...plan.plan.nodes[0] },
      { ...plan.plan.nodes[1], dependsOn: ["ghost"] },
    ] },
  };
  const migrated = validateAgainstWorkflow(wf, forged);
  assert.ok(!migrated.ok);
  assert.match(migrated.error, /ghost/);
});

test("delivery failure leaves the run pending and retries after settle", async () => {
  const h = harness({ failSend: new Error("queue closed") });
  const wf = workflow([task("frame"), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# x", h.storeRoot);
  const ctx = h.ctx();
  runtime.handleSessionStart(ctx);
  await runtime.startWorkflow(ctx, wf, "");
  assert.equal(h.sent.length, 0);
  const early = await runtime.transition({ status: "completed", checkpoint: cp("framed") }, undefined, ctx);
  assert.ok(early.isError);
  assert.match(early.details.status, /delivery-pending/);
  h.pi.sendUserMessage = async (message) => h.sent.push(message);
  await runtime.handleAgentSettled(ctx);
  assert.equal(h.sent.length, 1, "delivery retries once the queue recovers");
  const after = await runtime.transition({ status: "completed", checkpoint: cp("done") }, undefined, ctx);
  assert.ok(!after.isError, "the run continues after recovery");
});

test("malformed met entries are rejected without state change", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["scope-clear"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# x", h.storeRoot);
  const ctx = h.ctx();
  runtime.handleSessionStart(ctx);
  await runtime.startWorkflow(ctx, wf, "");
  await runtime.handleAgentSettled(ctx);
  const badId = await runtime.transition({ status: "completed", met: ["NOT-VALID"], checkpoint: cp("framed") }, undefined, ctx);
  assert.ok(badId.isError);
  assert.match(badId.details.status, /invalid-transition/);
  const dupes = await runtime.transition({ status: "completed", met: ["scope-clear", "scope-clear"], checkpoint: cp("framed") }, undefined, ctx);
  assert.ok(dupes.isError);
  assert.match(dupes.details.status, /invalid-transition/);
  const fine = await runtime.transition({ status: "completed", met: ["scope-clear"], checkpoint: cp("framed") }, undefined, ctx);
  assert.ok(!fine.isError);
});

test("storage failure on abort keeps the run active", async () => {
  const h = harness();
  const wf = workflow([task("frame")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# x", h.storeRoot);
  const ctx = h.ctx();
  runtime.handleSessionStart(ctx);
  await runtime.startWorkflow(ctx, wf, "");
  h.entries.push = () => {
    throw new Error("append broke");
  };
  const result = await runtime.abort(undefined, ctx);
  assert.ok(result.isError);
  assert.match(result.details.status, /storage-failed/);
  const prompt = runtime.handleBeforeAgentStart({ systemPrompt: "" });
  assert.ok(prompt, "the run stays active and rendered");
});

test("oversized targets are refused before any snapshot is written", async () => {
  const h = harness();
  const wf = workflow([task("frame")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# x", h.storeRoot);
  const ctx = h.ctx();
  runtime.handleSessionStart(ctx);
  const big = "x".repeat(LIMITS.targetBytes + 1);
  await assert.rejects(() => runtime.startWorkflow(ctx, wf, big), /target exceeds 4096 bytes/);
  assert.equal(h.entries.length, 0, "no snapshot was appended for the refused start");
  assert.equal(runtime.state.status, "idle");
  await runtime.startWorkflow(ctx, wf, "x".repeat(LIMITS.targetBytes));
  assert.ok(h.entries.length >= 1, "the exact-limit target starts normally");
  assert.equal(runtime.state.status, "active");
});

test("transitions that exceed the memory bound are rejected without state change", async () => {
  const h = harness();
  const files = { root: "steps/frame.md" };
  const wf = workflow([
    task("discover"),
    ...Array.from({ length: 40 }, (_, i) => task(`inspect-${i}`)),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# x", h.storeRoot);
  const ctx = h.ctx();
  runtime.handleSessionStart(ctx);
  await runtime.startWorkflow(ctx, wf, "");
  await runtime.handleAgentSettled(ctx);
  const transition = runtime.transition.bind(runtime);
  const big = "x".repeat(16_000);
  const files64 = Array.from({ length: 64 }, (_, i) => `f${i}`);
  let result = await transition({ status: "completed", checkpoint: { summary: "found", data: { files: files64 } } }, undefined, ctx);
  assert.ok(!result.isError, result.content[0].text);
  for (let i = 0; i < 40; i += 1) {
    await runtime.handleAgentSettled(ctx);
    result = await transition({ status: "completed", checkpoint: { summary: "inspected", data: { blob: big } } }, undefined, ctx);
    if (result.isError) break;
  }
  assert.ok(result.isError, "accumulating loop checkpoints eventually hits the bound");
  assert.match(result.details.status, /memory-bound/);
  const prompt = runtime.handleBeforeAgentStart({ systemPrompt: "" });
  assert.ok(prompt, "the run stays active at the last valid position");
});

test("an abort while delivery is pending suppresses the continuation message", async () => {
  const { DeliveryCoordinator } = await import("../../src/runtime/delivery.ts");
  let live = true;
  let releaseBeforeSend;
  const beforeSendGate = new Promise((resolve) => { releaseBeforeSend = resolve; });
  const sent = [];
  const notices = [];
  const coordinator = new DeliveryCoordinator({
    send: async (message) => { sent.push(message); },
    commitDelivered: () => {},
    notify: (message, level) => notices.push({ message, level }),
  });
  const delivery = coordinator.deliver({
    runId: "r1",
    key: "root/second#attempt-1",
    message: "Continue workflow `r1` at root/second.",
    isLive: () => live,
    beforeSend: async () => { await beforeSendGate; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  live = false; // the run aborts while beforeSend is still pending
  releaseBeforeSend();
  const delivered = await delivery;
  assert.equal(delivered, false);
  assert.equal(sent.length, 0, "the send is never invoked once the run is no longer live");
  assert.equal(coordinator.sentDelivery, null, "no delivery marker is recorded");
});

test("loop aggregates keep one shape regardless of output size", () => {
  const store = memoryStore();
  const run = (blobSize) => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const wf = workflow([task("gather"), loop("review", "for-each", { maxIterations: 8 }), task("deliver")]);
    let state = start(wf, { runId: "r1" }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: items })) }, store).state;
    let result = { ok: true, state };
    for (let i = 0; i < items.length; i += 1) {
      result = transition(wf, result.state, { type: "outcome", outcome: completed(cp(`reviewed ${items[i]}`, blobSize ? { blob: "x".repeat(blobSize) } : undefined)) }, store);
      assert.ok(result.ok, `iteration ${i + 1} should succeed`);
    }
    return result.state.checkpoints["root/review"].data;
  };
  const small = run(10);
  const big = run(2750);
  assert.equal(big.iterations, 6);
  const shape = (data) => JSON.stringify(data, (key, value) => (typeof value === "object" && value !== null && typeof value.checksum === "string" ? "<ref>" : value));
  assert.equal(shape(big), shape(small), "the aggregate schema does not depend on output size");
  assert.ok(shape(small).includes("<ref>"), "even small outputs are stored as references");
  const ref = big.results[0].outputs["review-step"];
  assert.ok(ref, "outputs stay in the fixed results shape");
  assert.ok(ref.size >= 2750, "the reference records the full stored size");
  assert.ok(small.results[0].outputs["review-step"].size < ref.size);
});

test("loop aggregates over the checkpoint bound are rejected", () => {
  const items = ["a".repeat(2710), "b".repeat(2710), "c".repeat(2710), "d".repeat(2710), "e".repeat(2710), "f".repeat(2710)];
  const wf = workflow([task("gather"), loop("review", "for-each", { maxIterations: 8 }), task("deliver")]);
  const store = memoryStore();
  let state = start(wf, { runId: "r1" }, store).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: items })) }, store).state;
  let result = { ok: true, state };
  for (let i = 0; i < items.length - 1; i += 1) {
    result = transition(wf, result.state, { type: "outcome", outcome: completed(cp(`reviewed ${items[i]}`)) }, store);
    assert.ok(result.ok, `iteration ${i + 1} should succeed`);
  }
  const oversized = transition(wf, result.state, { type: "outcome", outcome: completed(cp(`reviewed ${items.at(-1)}`)) }, store);
  assert.ok(!oversized.ok, "an aggregate over the checkpoint bound cannot commit");
  assert.match(oversized.error, /exceeds 16384 bytes/);
});
