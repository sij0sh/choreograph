import test from "node:test";
import assert from "node:assert/strict";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { completed, cp, sequence, task, workflow } from "./helpers.mjs";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


const LEAF_KINDS = new Set(["task", "node"]);

function isLeaf(frame) {
  return LEAF_KINDS.has(frame.kind) || (frame.kind === "plan" && frame.mode === "create");
}

test("invariant: every active execution has exactly one current leaf", () => {
  const wf = workflow([task("a"), sequence("s", [task("b"), task("c")]), task("d")]);
  let state = start(wf, { runId: "r1" }).state;
  for (let i = 0; i < 4; i += 1) {
    const leaf = state.stack.at(-1);
    assert.ok(isLeaf(leaf), "the top frame is the leaf");
    state.stack.slice(0, -1).forEach((frame) => {
      assert.ok(!isLeaf(frame), "frames below the top are structural containers");
    });
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("done")) }).state;
  }
  assert.equal(state.status, "completed");
});

test("invariant: every frame serializes through JSON", () => {
  const wf = workflow([task("a"), sequence("s", [task("b")]), task("c")]);
  let state = start(wf, { runId: "r1" }).state;
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state, "the whole execution round-trips");
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("done")) }).state;
  }
});

test("invariant: structural blocks hold no effects of their own", () => {
  const wf = workflow([task("a"), sequence("s", [task("b")]), task("c")]);
  const started = start(wf, { runId: "r1" });
  const before = structuredClone(started.state);
  const result = transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(result.ok);
  assert.deepEqual(started.state.stack, before.stack, "structural advancement never rewrites the prior stack");
  assert.equal(result.state.checkpoints["root/s"], undefined, "structural advancement records no checkpoint of its own");
});

test("invariant: retry budgets are finite", () => {
  const wf = workflow([task("only", { recovery: { maxAttempts: 1 } })]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("one") } }).state;
  const blocked = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("two") } });
  assert.ok(blocked.ok);
  assert.equal(blocked.effect.kind, "stay", "the exhausted budget ends in a blocked stay");
});

test("invariant: tasks describe failure while the policy parks them", () => {
  const wf = workflow([task("only", { recovery: { maxAttempts: 1 } })]);
  const started = start(wf, { runId: "r1" });
  const result = transition(wf, started.state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("stuck"), issues: [{ target: "only", reason: "r" }] } });
  assert.ok(result.ok);
  assert.equal(result.effect.kind, "stay", "a one-attempt policy parks the position regardless of issues");
});


test("invariant: model-generated work selects trusted operators only", () => {
  const wf = workflow([
    task("a"),
    { kind: "plan", id: "p", operators: ["inspect", "trace"] },
  ]);
  let state = transition(wf, start(wf, { runId: "r1" }).state, { type: "outcome", outcome: completed(cp("a")) }).state;
  const result = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", { plan: { version: 1, nodes: [
      { id: "n1", operator: "inspect", objective: "o" },
      { id: "n2", operator: "shell", objective: "o", dependsOn: ["n1"] },
    ] } })),
  });
  assert.ok(!result.ok, "an untrusted operator is rejected at plan validation");
  assert.match(result.error, /operator/i);
});

test("invariant: blocking always leaves a resumable checkpoint", () => {
  const wf = workflow([task("only", { recovery: { maxAttempts: 1 } })]);
  let state = start(wf, { runId: "r1" }).state;
  const blocked = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("stuck", { hint: "ask user" }) } });
  assert.ok(blocked.ok);
  assert.equal(blocked.effect.kind, "stay");
  assert.equal(Object.keys(blocked.state.checkpoints).length, 1, "the blocked position keeps its checkpoint");
  const resumed = transition(wf, blocked.state, { type: "outcome", outcome: completed(cp("unstuck")) });
  assert.ok(resumed.ok, "the blocked position resumes by transition");
});
