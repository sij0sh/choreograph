import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, loop, memoryStore, needsWork, script, sequence, task, workflow } from "./helpers.mjs";

function publishedPayloads(store, output) {
  return store.published.filter((entry) => entry.ref.output === output).map((entry) => entry.value);
}

function loopOf(id, children, options = {}) {
  return {
    kind: "loop",
    id,
    mode: options.mode ?? "for-each",
    body: sequence(`${id}-body`, children),
    maxIterations: options.maxIterations ?? 8,
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.mode === "repeat-until"
      ? { condition: options.condition ?? { from: children.at(-1).id, select: "/data/exitCode", op: "equals", value: 0 } }
      : { itemsBinding: options.itemsBinding ?? { from: "gather", select: "/data/files" } }),
  };
}

function gatherOutput(files) {
  return { files };
}

function startGathered(wf, files) {
  const started = start(wf, { runId: "r1" });
  assert.ok(started.ok, started.ok ? "" : started.error);
  const gathered = transition(wf, started.state, { type: "outcome", outcome: completed(cp("gathered", gatherOutput(files))) });
  assert.ok(gathered.ok, gathered.ok ? "" : gathered.error);
  return gathered.state;
}

test("a multi-node body runs every step once per item and aggregates each step's output", () => {
  const gather = task("gather");
  const wf = workflow([gather, loopOf("review", [task("read-one"), task("check-one")]), task("deliver")]);
  const store = memoryStore();
  let state = startGathered(wf, ["a", "b"]);
  assert.equal(state.stack.at(-1).key, "root/review/loop[1]/read-one");
  for (const [iteration, item] of [["1", "a"], ["1", "a"], ["2", "b"], ["2", "b"]]) {
    assert.equal(state.stack.at(-1).key, `root/review/loop[${iteration}]/${state.stack.at(-1).blockId}`);
    state = transition(wf, state, { type: "outcome", outcome: completed(cp(`handled ${item} at ${state.stack.at(-1).blockId}`, { note: `${state.stack.at(-1).blockId}:${item}` })) }, store).state;
  }
  const aggregate = state.checkpoints["root/review"];
  assert.ok(aggregate, "the loop writes one aggregate");
  assert.deepEqual(aggregate.data.results.map((entry) => Object.keys(entry.outputs).sort()), [["check-one", "read-one"], ["check-one", "read-one"]], "each iteration records every body step");
  assert.deepEqual(publishedPayloads(store, "1/read-one"), [{ note: "read-one:a" }]);
  assert.deepEqual(publishedPayloads(store, "1/check-one"), [{ note: "check-one:a" }]);
  assert.deepEqual(publishedPayloads(store, "2/read-one"), [{ note: "read-one:b" }]);
  assert.deepEqual(publishedPayloads(store, "2/check-one"), [{ note: "check-one:b" }]);
  assert.equal(state.stack.at(-1).blockId, "deliver", "the loop hands off to the next block");
});

test("a script body step runs inside its iteration and its output lands in the aggregate", () => {
  const wf = workflow([
    task("gather"),
    loopOf("review", [task("read-one"), script("check-one", { spec: { argv: ["node", "-e", "process.stdout.write(JSON.stringify({ verdict: 'ok' }))"], inheritEnv: ["PATH"], stdout: "json" } })]),
    task("deliver"),
  ]);
  let state = startGathered(wf, ["a"]);
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("read", { note: "n" })) }).state;
  assert.equal(state.stack.at(-1).blockId, "check-one", "the script is the second body step");
  const store = memoryStore();
  const exited = transition(wf, state, {
    type: "process-exit",
    key: "root/review/loop[1]/check-one",
    exit: { code: 0, timedOut: false, stdout: `${JSON.stringify({ verdict: "ok" })}\n`, stderr: "", truncated: false },
  }, store);
  assert.ok(exited.ok, exited.ok ? "" : exited.error);
  const aggregate = exited.state.checkpoints["root/review"];
  const ref = aggregate.data.results[0].outputs["check-one"];
  assert.equal(ref.output, "1/check-one", "the script output joins the iteration record as an artifact reference");
  assert.deepEqual(publishedPayloads(store, "1/check-one"), [{ verdict: "ok" }]);
  assert.equal(exited.state.stack.at(-1).blockId, "deliver");
});

test("a body step's output contract is enforced before its checkpoint commits", () => {
  const wf = workflow([
    task("gather"),
    loopOf("review", [task("read-one", { output: "report" })]),
    task("deliver"),
  ], {
    contracts: { report: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } } },
  });
  let state = startGathered(wf, ["a"]);
  const rejected = transition(wf, state, { type: "outcome", outcome: completed(cp("missing verdict", { wrong: true })) });
  assert.ok(!rejected.ok, "a contract violation rejects the completion");
  assert.match(rejected.error ?? "", /report/);
  assert.equal(state.checkpoints["root/review/loop[1]/read-one"], undefined, "nothing was recorded for the rejected outcome");
  const accepted = transition(wf, state, { type: "outcome", outcome: completed(cp("read", { verdict: "ok" })) }, memoryStore());
  assert.ok(accepted.ok, accepted.ok ? "" : accepted.error);
  assert.ok(accepted.state.checkpoints["root/review/loop[1]/read-one"]);
});

test("invalidating a body step re-runs only the current iteration", () => {
  const gather = task("gather");
  const wf = workflow([gather, loopOf("review", [
    task("produce"),
    task("verify", { inputs: { base: { from: "produce" } }, recovery: { maxAttempts: 1, maxReplans: 0, strategy: ["invalidate", "block"] } }),
  ]), task("deliver")]);
  const store = memoryStore();
  let state = startGathered(wf, ["a", "b"]);
  // Iteration 1 completes cleanly.
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("produce 1", { pass: 1 })) }, store).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("verify 1", { pass: 1, ok: true })) }, store).state;
  // Iteration 2: verify rejects produce's output.
  assert.equal(state.stack.at(-1).key, "root/review/loop[2]/produce");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("produce 2", { pass: 2 })) }, store).state;
  const invalidation = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("stale input"), [{ target: "produce", reason: "produce used the wrong item" }]),
  });
  assert.ok(invalidation.ok, invalidation.ok ? "" : invalidation.error);
  const leaf = invalidation.state.stack.at(-1);
  assert.equal(leaf.blockId, "produce", "the run rewinds to the invalidated body step");
  assert.equal(leaf.key, "root/review/loop[2]/produce", "the rewind stays inside iteration 2");
  assert.ok(invalidation.state.checkpoints["root/review/loop[1]/produce"], "iteration 1's produce checkpoint survives");
  assert.ok(invalidation.state.checkpoints["root/review/loop[1]/verify"], "iteration 1's verify checkpoint survives");
  assert.equal(invalidation.state.checkpoints["root/review/loop[2]/produce"], undefined, "the stale iteration-2 checkpoint is removed");
  assert.equal(invalidation.state.loops["root/review"].iteration, 2, "the loop keeps its iteration");
  // Re-run the affected iteration-2 steps; the loop then completes.
  let repaired = transition(wf, invalidation.state, { type: "outcome", outcome: completed(cp("produce 2 fixed", { pass: 2, fixed: true })) }, store);
  assert.ok(repaired.ok, repaired.ok ? "" : repaired.error);
  assert.equal(repaired.state.stack.at(-1).key, "root/review/loop[2]/verify");
  repaired = transition(wf, repaired.state, { type: "outcome", outcome: completed(cp("verify 2 fixed", { pass: 2, ok: true })) }, store);
  assert.ok(repaired.ok, repaired.ok ? "" : repaired.error);
  const aggregate = repaired.state.checkpoints["root/review"];
  assert.equal(aggregate.data.iterations, 2, "the loop still ran exactly two iterations");
  assert.deepEqual(publishedPayloads(store, "1/verify"), [{ pass: 1, ok: true }], "iteration 1 keeps its original verify output");
  assert.deepEqual(publishedPayloads(store, "2/produce"), [{ pass: 2, fixed: true }], "iteration 2 records the repaired produce output");
  assert.deepEqual(publishedPayloads(store, "2/verify"), [{ pass: 2, ok: true }]);
});

test("an invalidation reaching outside the loop body restarts the whole loop", () => {
  const wf = workflow([
    task("gather"),
    loopOf("review", [
      task("produce"),
      task("verify", { inputs: { base: { from: "produce" }, gathered: { from: "gather" } }, recovery: { maxAttempts: 1, maxReplans: 0, strategy: ["invalidate", "block"] } }),
    ]),
    task("deliver"),
  ]);
  let state = startGathered(wf, ["a", "b"]);
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("produce 1")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("verify 1")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("produce 2")) }).state;
  const invalidation = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("gathered data is stale"), [{ target: "gather", reason: "the source set changed" }]),
  });
  assert.ok(invalidation.ok, invalidation.ok ? "" : invalidation.error);
  assert.equal(invalidation.state.stack.at(-1).blockId, "gather", "the run rewinds past the loop to the outer producer");
  assert.equal(invalidation.state.loops["root/review"], undefined, "the loop state is dropped for a full restart");
});
