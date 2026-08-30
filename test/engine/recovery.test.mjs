import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, needsWork, task, workflow } from "./helpers.mjs";

const OPERATORS = new Map([
  ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ["trace", { id: "trace", path: "operators/trace.md", description: "Trace flow." }],
]);

function node(id, operator = "inspect", extra = {}) {
  return { id, operator, objective: `Objective for ${id}`, done: [`${id}-done`], ...extra };
}

function planOf(nodes) {
  return { status: "completed", checkpoint: { summary: "Planned.", data: { plan: { version: 1, nodes } } } };
}

function passNode(id) {
  return { status: "completed", met: [`${id}-done`], checkpoint: { summary: `${id} done` } };
}

function planWorkflow(children, options = {}) {
  return workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect", "trace"], ...(options.plan ?? {}) }, ...children], {
    operators: OPERATORS,
  });
}

function seededPlan(wf, nodes) {
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: planOf(nodes) }).state;
  return state;
}

test("a node retries in place and stores the failure as the prior attempt", () => {
  const wf = planWorkflow([]);
  const state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  const retry = transition(wf, state, { type: "outcome", outcome: needsWork(cp("thin evidence"), [{ target: "probe", reason: "no direct evidence" }]) });
  assert.ok(retry.ok, retry.ok ? "" : retry.error);
  assert.equal(retry.effect.kind, "deliver");
  const leaf = retry.state.stack.at(-1);
  assert.equal(leaf.nodeId, "probe");
  assert.equal(leaf.attempt, 2);
  assert.equal(retry.state.checkpoints["root/investigate/probe"].summary, "thin evidence", "the needs-work checkpoint stays at the current key as the prior attempt");
});

test("a node parks after exhausting its retries", () => {
  const wf = planWorkflow([]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("first try")) }).state;
  const parked = transition(wf, state, { type: "outcome", outcome: needsWork(cp("second try")) });
  assert.ok(parked.ok);
  assert.equal(parked.effect.kind, "stay", "the second failure parks the node");
  const leaf = parked.state.stack.at(-1);
  assert.equal(leaf.kind, "node");
  assert.equal(leaf.nodeId, "probe", "the run never leaves the current node");
  assert.equal(parked.state.checkpoints["root/investigate/probe"].summary, "second try");
});

test("issues[] never rewinds completed work", () => {
  const wf = planWorkflow([task("verify", { recovery: { maxAttempts: 1 } })]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: passNode("probe") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("map") }).state;
  assert.equal(state.stack.at(-1).blockId, "verify");
  const parked = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("probe evidence is weak"), [{ target: "probe", reason: "missing direct evidence" }]),
  });
  assert.ok(parked.ok, parked.ok ? "" : parked.error);
  assert.equal(parked.effect.kind, "stay", "the verifier parks on its first failure instead of rewinding");
  assert.deepEqual(Object.keys(parked.state.plans["root/investigate"].results), ["probe", "map"], "completed node results are untouched");
  assert.equal(parked.state.stack.at(-1).blockId, "verify", "the stack stays at the current position");
});

test("a task retries and then parks with a resumable checkpoint", () => {
  const wf = workflow([task("gather"), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  const retry = transition(wf, state, { type: "outcome", outcome: needsWork(cp("not gathered yet")) });
  assert.ok(retry.ok);
  assert.equal(retry.effect.kind, "deliver");
  assert.equal(retry.state.stack.at(-1).blockId, "gather");
  assert.equal(retry.state.stack.at(-1).attempt, 2);
  assert.equal(retry.state.checkpoints["root/gather"].summary, "not gathered yet", "the prior attempt summary is stored before the retry");
  const parked = transition(wf, retry.state, { type: "outcome", outcome: needsWork(cp("still stuck")) });
  assert.ok(parked.ok);
  assert.equal(parked.effect.kind, "stay");
  assert.ok(parked.state.checkpoints["root/gather"], "parking leaves a resumable checkpoint");
});

test("a later outcome replaces the prior attempt checkpoint", () => {
  const wf = workflow([task("gather"), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("first failure")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("gathered")) }).state;
  assert.equal(state.checkpoints["root/gather"].summary, "gathered", "the completion replaces the prior attempt checkpoint");
});

test("max_attempts extends the retry budget", () => {
  const wf = workflow([task("gather", { recovery: { maxAttempts: 3 } }), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("one")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("two")) }).state;
  assert.equal(state.stack.at(-1).attempt, 3);
  const parked = transition(wf, state, { type: "outcome", outcome: needsWork(cp("three")) });
  assert.ok(parked.ok);
  assert.equal(parked.effect.kind, "stay");
});

test("plan creation retries and then blocks", () => {
  const wf = planWorkflow([]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  const retry = transition(wf, state, { type: "outcome", outcome: needsWork(cp("cannot plan yet")) });
  assert.ok(retry.ok);
  assert.equal(retry.state.stack.at(-1).attempt, 2);
  const blocked = transition(wf, retry.state, { type: "outcome", outcome: needsWork(cp("still stuck")) });
  assert.ok(blocked.ok);
  assert.equal(blocked.effect.kind, "stay");
  assert.ok(blocked.state.checkpoints["root/investigate"]);
});

test("a parked node keeps the plan resumable and completes on the retry", () => {
  const wf = planWorkflow([]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("first try")) }).state;
  const parked = transition(wf, state, { type: "outcome", outcome: needsWork(cp("second try")) }).state;
  assert.deepEqual(Object.keys(Object.values(parked.plans)[0].results), [], "the failed node has no result");
  state = transition(wf, parked, { type: "outcome", outcome: passNode("probe") }).state;
  assert.equal(state.stack.at(-1).nodeId, "map", "the run advances after the node completes");
});
