import test from "node:test";
import assert from "node:assert/strict";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { completed, cp, task, workflow } from "./helpers.mjs";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


const OPERATOR_SCHEMA = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
};

test("a task output violating its contract is rejected without state change", () => {
  const wf = workflow([task("frame", { output: "task-contract" }), task("deliver")], {
    contracts: { "task-contract": { type: "object", required: ["objective"], properties: { objective: { type: "string", minLength: 3 } } } },
  });
  let state = start(wf, { runId: "r1" }).state;
  const bad = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("objective too short", { objective: "ab" })),
  });
  assert.ok(!bad.ok);
  assert.match(bad.error, /violates contract task-contract/);
  assert.match(bad.error, /objective/);
  assert.equal(state.checkpoints["root/frame"], undefined, "the invalid transition stored nothing");

  const good = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("objective set", { objective: "review the change" })),
  });
  assert.ok(good.ok);
  assert.equal(good.state.stack.at(-1).blockId, "deliver");
  assert.equal(good.state.checkpoints["root/frame"].data.objective, "review the change");
});

test("blocked task checkpoints also satisfy their output contract", () => {
  const wf = workflow([task("frame", { output: "task-contract" })], {
    contracts: { "task-contract": { type: "object", required: ["objective"] } },
  });
  const state = start(wf, { runId: "r1" }).state;
  const bad = transition(wf, state, {
    type: "outcome",
    outcome: { status: "blocked", checkpoint: cp("blocked", {}) },
  });
  assert.ok(!bad.ok);
  assert.match(bad.error, /checkpoint root\/frame violates contract task-contract/);
  assert.equal(state.checkpoints["root/frame"], undefined);
});

test("a node result violating its operator contract is rejected", () => {
  const operators = new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect.", output: "finding" }],
  ]);
  const wf = workflow([{ kind: "plan", id: "investigate", operators: ["inspect"] }], {
    operators,
    contracts: { finding: OPERATOR_SCHEMA },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", { plan: { version: 1, nodes: [
      { id: "a", operator: "inspect", objective: "o", done: ["a-done"] },
      { id: "b", operator: "inspect", objective: "o", done: ["b-done"] },
    ] } })),
  }).state;
  const bad = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["a-done"], checkpoint: cp("missing summary data", {}) },
  });
  assert.ok(!bad.ok, bad.ok ? "" : "");
  if (!bad.ok) assert.match(bad.error, /violates contract finding/);
  assert.equal(Object.keys(state.plans["root/investigate"].results).length, 0, "the invalid result stored nothing");

  const good = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["a-done"], checkpoint: cp("node a", { summary: "found it" }) },
  });
  assert.ok(good.ok);
  assert.equal(good.state.plans["root/investigate"].results.a.data.summary, "found it");
});

test("plan creation retains its checkpoint without the plan payload", () => {
  const operators = new Map([["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect." }]]);
  const wf = workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }], { operators });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("plan formed", {
      rationale: "two probes",
      plan: { version: 1, nodes: [
        { id: "a", operator: "inspect", objective: "o", done: ["a-done"] },
        { id: "b", operator: "inspect", objective: "o", done: ["b-done"] },
      ] },
    })),
  }).state;
  const stored = state.checkpoints["root/investigate"];
  assert.ok(stored, "the plan-creation checkpoint persists");
  assert.equal(stored.summary, "plan formed");
  assert.deepEqual(stored.data, { rationale: "two probes" });
  assert.equal(stored.data?.plan, undefined, "the engine-owned plan payload is stripped");
  assert.ok(state.checkpointOrder.includes("root/investigate"));
});

test("transitions without contracts behave identically", () => {
  const wf = workflow([task("a"), task("b")]);
  let state = start(wf, { runId: "r1" }).state;
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("any shape", { free: true, form: [1, 2] })) });
  assert.ok(result.ok);
  assert.deepEqual(result.state.checkpoints["root/a"].data, { free: true, form: [1, 2] });
});
