import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, sequence, task, workflow } from "./helpers.mjs";

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
  assert.deepEqual(started.state, before, "structural advancement never mutates prior state");
});

test("invariant: loops snapshot their input collection on entry", () => {
  const wf = workflow([
    task("discover"),
    { kind: "foreach", id: "review", items: { root: "discover", path: ["files"] }, as: "file", body: sequence("body", [task("inspect")]) },
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["a", "b"] })) }).state;
  const frame = state.stack.find((f) => f.kind === "foreach");
  const snapshot = JSON.parse(JSON.stringify(frame));
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("one")) }).state;
  const after = state.stack.find((f) => f.kind === "foreach");
  assert.deepEqual([after.items, after.index], [snapshot.items, snapshot.index + 1], "iteration continues from the snapshotted collection");
});

test("invariant: retry and replan budgets are finite", () => {
  const wf = workflow([task("only", { recovery: { maxAttempts: 1, maxReplans: 0, strategy: ["retry", "block"] } })]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("one") } }).state;
  const blocked = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("two") } });
  assert.ok(blocked.ok);
  assert.equal(blocked.effect.kind, "stay", "the exhausted budget ends in a blocked stay");
});

test("invariant: tasks describe failure while policy chooses recovery", () => {
  const wf = workflow([task("only", { recovery: { maxAttempts: 3, maxReplans: 0, strategy: ["block"] } })]);
  const started = start(wf, { runId: "r1" });
  const result = transition(wf, started.state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("stuck"), issues: [{ target: "only", reason: "r" }] } });
  assert.ok(result.ok);
  assert.equal(result.effect.kind, "stay", "a retry-free policy blocks immediately regardless of issues");
});

test.todo("invariant: a completed checkpoint is immutable unless invalidated (covered by recovery invalidation tests)");
test.todo("invariant: model-generated work selects trusted operators only (needs plan blocks)");
test.todo("invariant: model-generated work cannot widen capabilities (needs plan blocks)");
test.todo("invariant: dependency references resolve (covered by planning validation tests)");
test.todo("invariant: retained results survive replanning unless invalidated (covered by recovery tests)");
test.todo("invariant: retry and replan budgets are finite (covered above and by recovery tests)");
test.todo("invariant: runtime state changes only after a durable snapshot commit (needs the coordinator)");
test.todo("invariant: restored snapshots pass semantic validation against the current workflow (needs persistence)");
test.todo("invariant: invalid snapshots never partially resume (covered by persistence tests)");
test.todo("invariant: tasks describe failure while policy chooses recovery (covered above)");
test.todo("invariant: recovery never exceeds configured bounds (covered above and by recovery tests)");
test.todo("invariant: blocking always leaves a resumable checkpoint (needs the coordinator)");
