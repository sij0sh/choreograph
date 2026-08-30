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

