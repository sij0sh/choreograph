import test from "node:test";
import assert from "node:assert/strict";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { blocked, completed, cp, loop, memoryStore, needsWork, sequence, task, workflow } from "./helpers.mjs";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


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

test("a rejected completion reports unknown and missing criteria together with the valid ids", () => {
  const wf = workflow([task("frame", { done: ["scope-clear", "target-known"] })]);
  const started = start(wf, { runId: "r1" });
  const bad = transition(wf, started.state, { type: "outcome", outcome: completed(cp("partial"), ["scope-clear", "bogus"]) });
  assert.ok(!bad.ok);
  assert.match(bad.error, /unknown criterion id: bogus/);
  assert.match(bad.error, /missing: target-known/);
  assert.match(bad.error, /required ids for this position: `scope-clear`, `target-known`/);
});

test("a rejected completion aggregates checkpoint and criteria violations in one message", () => {
  const wf = workflow([task("frame", { done: ["scope-clear"] })]);
  const started = start(wf, { runId: "r1" });
  const bad = transition(wf, started.state, {
    type: "outcome",
    outcome: { status: "completed", met: ["nope"], checkpoint: { data: { detail: "x" }, evidence: ["a".repeat(600)] } },
  });
  assert.ok(!bad.ok);
  assert.match(bad.error, /unknown criterion id: nope/);
  assert.match(bad.error, /missing: scope-clear/);
  assert.match(bad.error, /checkpoint\.summary must be a non-empty string/);
  assert.match(bad.error, /checkpoint\.evidence\[0\] exceeds 512 bytes \(was 600\)/);
  assert.match(bad.error, /exceeds 512 bytes \(was 600\)/);
  const violations = bad.error.split("; ").length;
  assert.ok(violations >= 4, `expected at least 4 distinct violations, got: ${bad.error}`);
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

test("needs-work retries the same position and stores a prior-attempt checkpoint", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const retry = transition(wf, started.state, { type: "outcome", outcome: needsWork(cp("not enough evidence"), [{ target: "a", reason: "missing test" }]) });
  assert.ok(retry.ok);
  assert.equal(retry.effect.kind, "deliver");
  assert.equal(retry.state.stack.at(-1).attempt, 2);
  assert.equal(retry.state.stack.at(-1).blockId, "a");
  assert.equal(retry.state.checkpoints["root/a"].summary, "not enough evidence", "the retry keeps the prior attempt summary at the current key");
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


test("transitions after completion fail", () => {
  const wf = workflow([task("a")]);
  const started = start(wf, { runId: "r1" });
  const done = transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(done.ok);
  const after = transition(wf, done.state, { type: "outcome", outcome: completed(cp("again")) });
  assert.ok(!after.ok);
});

test("the engine returns the committed state and never rewrites the input stack", () => {
  const wf = workflow([task("a"), task("b")]);
  const started = start(wf, { runId: "r1" });
  const before = structuredClone(started.state);
  const done = transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(done.ok);
  assert.equal(done.state.checkpoints["root/a"]?.summary, "done");
  assert.deepEqual(done.state.checkpointOrder, ["root/a"]);
  assert.deepEqual(started.state.stack, before.stack, "the input stack still describes the pre-commit position");
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

test("for_each runs the body once per item and aggregates", () => {
  const gather = task("gather", { output: "files" });
  const item = loop("review");
  const deliver = task("deliver");
  const wf = workflow([gather, item, deliver], {
    contracts: { files: { type: "object", required: ["files"], properties: { files: { type: "array" } } } },
  });
  let state = start(wf, { runId: "r1" }).state;
  assert.equal(state.stack.at(-1).blockId, "gather");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("gathered", { files: ["a", "b", "c"] })) }).state;
  const leaf = state.stack.at(-1);
  assert.equal(leaf.kind, "task");
  assert.equal(leaf.blockId, "review-step");
  assert.equal(leaf.key, "root/review/loop[1]/review-step");
  const store = memoryStore();
  for (const name of ["a", "b", "c"]) {
    assert.equal(state.stack.at(-1).key, `root/review/loop[${name.charCodeAt(0) - 96}]/review-step`);
    state = transition(wf, state, { type: "outcome", outcome: completed(cp(`reviewed ${name}`)) }, store).state;
  }
  const aggregate = state.checkpoints["root/review"];
  assert.ok(aggregate, "the loop writes one aggregate checkpoint");
  assert.deepEqual(aggregate.data, {
    mode: "for-each",
    iterations: 3,
    results: [
      { iteration: 1, item: "a", outputs: {} },
      { iteration: 2, item: "b", outputs: {} },
      { iteration: 3, item: "c", outputs: {} },
    ],
  });
  assert.equal(state.stack.at(-1).blockId, "deliver");
  assert.equal(state.loops["root/review"], undefined, "loop state is cleared on completion");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("done")) }).state;
  assert.equal(state.status, "completed");
});

test("for_each with zero items skips the body and records zero iterations", () => {
  const gather = task("gather");
  const wf = workflow([gather, loop("review"), task("deliver")]);
  let state = start(wf, { runId: "r1" }, memoryStore()).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("empty", { files: [] })) }, memoryStore()).state;
  const aggregate = state.checkpoints["root/review"];
  assert.ok(aggregate);
  assert.deepEqual(aggregate.data, { mode: "for-each", iterations: 0, results: [] });
  assert.equal(state.stack.at(-1).blockId, "deliver");
});

test("a loop without the run's artifact store cannot record its aggregate", () => {
  const wf = workflow([task("gather"), loop("review", { maxIterations: 1 }), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: ["a"] })) }).state;
  const rejected = transition(wf, state, { type: "outcome", outcome: completed(cp("only item", { ok: true })) });
  assert.ok(!rejected.ok);
  assert.match(rejected.error, /no artifact store/);
});

test("loop guards skip the whole loop", () => {
  const gate = task("gate");
  const guarded = loop("review", {});
  guarded.guard = { from: "gate", select: "/data/on", op: "equals", value: true };
  const wf = workflow([gate, guarded, task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("gated", { on: false })) }).state;
  const skipped = state.checkpoints["root/review"];
  assert.equal(skipped.skipped, true);
  assert.equal(state.stack.at(-1).blockId, "deliver");
});

test("for_each rejects item lists above the cap", () => {
  const wf = workflow([task("gather"), loop("review", { maxIterations: 2 })]);
  let state = start(wf, { runId: "r1" }).state;
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("too many", { files: ["a", "b", "c"] })) });
  assert.ok(!result.ok);
  assert.match(result.error, /above its cap of 2/);
});

test("for_each requires the item binding to resolve to a list", () => {
  const wf = workflow([task("gather"), loop("review", { itemsBinding: { from: "gather", select: "/data/total" } }), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("scalar", { total: 3 })) });
  assert.ok(!result.ok);
  assert.match(result.error, /must resolve to a list/);
});

test("agent task positions record node invocations through their lifecycle", () => {
  const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
  const started = start(wf, { runId: "r1" });
  const first = started.state.invocations?.["root/frame"];
  assert.ok(first, "the first agent leaf records an invocation");
  assert.equal(first.runner, "agent");
  assert.equal(first.status, "running");
  assert.equal(first.attempt, 1);

  const stuck = transition(wf, started.state, { type: "outcome", outcome: blocked(cp("stuck")) });
  assert.ok(stuck.ok);
  assert.equal(stuck.state.invocations?.["root/frame"]?.status, "waiting");

  const retried = transition(wf, stuck.state, { type: "outcome", outcome: needsWork(cp("again")) });
  assert.ok(retried.ok);
  assert.equal(retried.state.invocations?.["root/frame"]?.status, "running");
  assert.equal(retried.state.invocations?.["root/frame"]?.attempt, 2);

  const done = transition(wf, retried.state, { type: "outcome", outcome: completed(cp("framed"), ["framed"]) });
  assert.ok(done.ok);
  assert.equal(done.state.invocations?.["root/frame"]?.status, "succeeded");
  assert.equal(done.state.invocations?.["root/deliver"]?.status, "running", "the next agent leaf records its own invocation");
  assert.equal(done.state.invocations?.["root/deliver"]?.runner, "agent");
});
