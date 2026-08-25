import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { blocked, completed, cp, needsWork, sequence, task, workflow } from "./helpers.mjs";

function run(tasks) {
  return start(workflow(tasks), { runId: "r1", target: "t" });
}

test("start enters the first task with a deliver effect", () => {
  const result = run([task("frame"), task("deliver")]);
  assert.ok(result.ok);
  assert.equal(result.effect.kind, "deliver");
  assert.equal(result.state.status, "active");
  assert.deepEqual(
    result.state.stack.map((f) => f.kind),
    ["sequence", "task"],
  );
  assert.equal(result.state.stack[1].blockId, "frame");
  assert.equal(result.state.stack[1].attempt, 1);
});

test("completing a task advances to the next", () => {
  const started = run([task("frame"), task("deliver")]);
  const next = transition(workflow([task("frame"), task("deliver")]), started.state, { type: "outcome", outcome: completed(cp("framed")) });
  assert.ok(next.ok);
  assert.equal(next.effect.kind, "deliver");
  assert.equal(next.state.stack[next.state.stack.length - 1].blockId, "deliver");
  assert.ok(next.state.checkpoints["root/frame"], "the frame checkpoint is stored at its position key");
});

test("completing the final task completes the run", () => {
  const wf = workflow([task("only")]);
  const started = start(wf, { runId: "r1" });
  const done = transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(done.ok);
  assert.equal(done.effect.kind, "complete");
  assert.equal(done.state.status, "completed");
  assert.equal(done.state.stack.length, 0);
});

test("nested sequences execute in order", () => {
  const inner = sequence("inner", [task("b"), task("c")]);
  const wf = workflow([task("a"), inner, task("d")]);
  let state = start(wf, { runId: "r1" }).state;
  const visited = [state.stack.at(-1).blockId];
  for (const id of ["a", "b", "c", "d"]) {
    assert.equal(state.stack.at(-1).blockId, id);
    const next = transition(wf, state, { type: "outcome", outcome: completed(cp(`${id} done`)) });
    assert.ok(next.ok, `transition at ${id} should succeed`);
    state = next.state;
    if (next.effect.kind !== "complete") visited.push(state.stack.at(-1).blockId);
  }
  assert.equal(state.status, "completed");
  assert.deepEqual(Object.keys(state.checkpoints), ["root/a", "root/inner/b", "root/inner/c", "root/d"]);
});

test("criteria gate completion", () => {
  const wf = workflow([task("frame", { done: ["scope-clear", "target-known"] })]);
  const started = start(wf, { runId: "r1" });
  const missing = transition(wf, started.state, { type: "outcome", outcome: completed(cp("partial"), ["scope-clear"]) });
  assert.ok(!missing.ok);
  assert.match(missing.error, /missing: target-known/);
  const unknown = transition(wf, started.state, { type: "outcome", outcome: completed(cp("partial"), ["scope-clear", "target-known", "bogus"]) });
  assert.ok(!unknown.ok);
  assert.match(unknown.error, /unknown criterion id: bogus/);
  const pass = transition(wf, started.state, { type: "outcome", outcome: completed(cp("framed"), ["target-known", "scope-clear"]) });
  assert.ok(pass.ok);
});

test("met and issues are rejected outside their outcomes", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const withMet = transition(wf, started.state, { type: "outcome", outcome: needsWork(cp("stuck")).met === undefined ? { status: "blocked", checkpoint: cp("x"), met: ["a"] } : needsWork(cp("stuck")) });
  assert.ok(!withMet.ok);
  const withIssues = transition(wf, started.state, { type: "outcome", outcome: { status: "blocked", checkpoint: cp("x"), issues: [{ target: "a", reason: "r" }] } });
  assert.ok(!withIssues.ok);
});

test("blocked stores the checkpoint and stays delivered", () => {
  const wf = workflow([task("a"), task("b")]);
  const started = start(wf, { runId: "r1" });
  const result = transition(wf, started.state, { type: "outcome", outcome: blocked(cp("waiting on user")) });
  assert.ok(result.ok);
  assert.equal(result.effect.kind, "stay");
  assert.equal(result.state.status, "active");
  assert.equal(result.state.stack.at(-1).blockId, "a");
  assert.ok(result.state.checkpoints["root/a"]);
  const resumed = transition(wf, result.state, { type: "outcome", outcome: completed(cp("unblocked")) });
  assert.ok(resumed.ok);
  assert.equal(resumed.state.stack.at(-1).blockId, "b");
});

test("a blocked checkpoint is replaced by the completed one", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const first = transition(wf, started.state, { type: "outcome", outcome: blocked(cp("one")) });
  assert.ok(first.ok);
  const second = transition(wf, first.state, { type: "outcome", outcome: blocked(cp("two")) });
  assert.ok(second.ok, "a second blocked report replaces the provisional checkpoint");
  assert.equal(second.state.checkpoints["root/a"].summary, "two");
  const done = transition(wf, second.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(done.ok);
  assert.equal(done.state.checkpoints["root/a"].summary, "done");
});

test("needs-work retries the same position without storing a checkpoint", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const retry = transition(wf, started.state, { type: "outcome", outcome: needsWork(cp("not enough evidence"), [{ target: "a", reason: "missing test" }]) });
  assert.ok(retry.ok);
  assert.equal(retry.effect.kind, "deliver");
  assert.equal(retry.state.stack.at(-1).attempt, 2);
  assert.equal(retry.state.stack.at(-1).blockId, "a");
  assert.equal(Object.keys(retry.state.checkpoints).length, 0);
});

test("needs-work past the attempt bound escalates to a blocked stay", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const first = transition(wf, started.state, { type: "outcome", outcome: needsWork(cp("one")) });
  assert.ok(first.ok);
  const second = transition(wf, first.state, { type: "outcome", outcome: needsWork(cp("two")) });
  assert.ok(second.ok);
  assert.equal(second.effect.kind, "stay");
  assert.equal(second.state.stack.at(-1).attempt, 2, "the attempt does not grow past the bound");
  assert.ok(second.state.checkpoints["root/a"], "the final checkpoint is recorded");
});

test("abort ends the run", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const aborted = transition(wf, started.state, { type: "abort" });
  assert.ok(aborted.ok);
  assert.equal(aborted.effect.kind, "aborted");
  assert.equal(aborted.state.status, "aborted");
  const after = transition(wf, aborted.state, { type: "outcome", outcome: completed(cp("late")) });
  assert.ok(!after.ok);
});

test("transitions after completion fail", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const done = transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(done.ok);
  const after = transition(wf, done.state, { type: "outcome", outcome: completed(cp("again")) });
  assert.ok(!after.ok);
});

test("the engine does not mutate the input state", () => {
  const wf = workflow([task("a"), task("b")]);
  const started = start(wf, { runId: "r1" });
  const before = structuredClone(started.state);
  transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.deepEqual(started.state, before);
});

test("identical runs produce identical states", () => {
  const wf = workflow([task("a"), sequence("s", [task("b"), task("c")]), task("d")]);
  const runOnce = () => {
    let state = start(wf, { runId: "r1", target: "x" }).state;
    for (let i = 0; i < 4; i += 1) {
      state = transition(wf, state, { type: "outcome", outcome: completed(cp(`step ${i}`)) }).state;
    }
    return state;
  };
  assert.deepEqual(runOnce(), runOnce());
});
