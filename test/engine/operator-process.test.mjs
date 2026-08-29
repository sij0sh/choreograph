import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { isArtifactRef } from "../../src/domain/artifacts.ts";
import { validateAgainstWorkflow } from "../../src/persistence/validate-stored-execution.ts";
import { completed, contractOf, cp, memoryStore, sequence, task, workflow } from "./helpers.mjs";

const FETCH_SCRIPT = {
  argv: ["node", "-e", "process.stdout.write(JSON.stringify({ value: 1 }))"],
  cwd: ".",
  timeoutMs: 10_000,
  acceptedExitCodes: [0],
  stdout: "json",
  stderr: "none",
  maxCaptureBytes: 65_536,
};

function operators(extra = {}) {
  return new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
    ["fetch", { id: "fetch", path: "operators/fetch.md", description: "Fetch data.", script: FETCH_SCRIPT, ...extra }],
  ]);
}

function processWorkflow(operatorExtra = {}, planExtra = {}) {
  return workflow(
    [
      task("frame"),
      { kind: "plan", id: "investigate", operators: ["inspect", "fetch"], ...planExtra },
      task("deliver"),
    ],
    { operators: operators(operatorExtra) },
  );
}

const PLAN = {
  version: 1,
  nodes: [
    { id: "look", operator: "inspect", objective: "Look around.", done: ["looked"] },
    { id: "fetch-data", operator: "fetch", objective: "Fetch the data.", dependsOn: ["look"] },
  ],
};

function toProcessNode(wf, state) {
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("planned", { plan: PLAN })) }).state;
  assert.equal(state.stack.at(-1).key, "root/investigate/look");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("looked around"), ["looked"]) }).state;
  assert.equal(state.stack.at(-1).key, "root/investigate/fetch-data");
  return state;
}

const exit = (overrides = {}) => ({ code: 0, timedOut: false, stdout: '{"value":1}', stderr: "", truncated: false, ...overrides });

test("a process operator node is routed to the process runner and rejects transitions", () => {
  const wf = processWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = toProcessNode(wf, state);
  assert.equal(state.invocations["root/investigate/fetch-data"].runner, "process");
  const rejected = transition(wf, state, { type: "outcome", outcome: completed(cp("tried")) });
  assert.ok(!rejected.ok);
  assert.match(rejected.error, /process operator node/);
});

test("an accepted exit completes the node, records the result, and advances", () => {
  const wf = processWorkflow();
  const store = memoryStore();
  let state = start(wf, { runId: "r1" }).state;
  state = toProcessNode(wf, state);
  const applied = transition(wf, state, { type: "process-exit", key: "root/investigate/fetch-data", exit: exit() }, store);
  assert.ok(applied.ok, applied.error);
  assert.equal(applied.effect.kind, "deliver");
  assert.equal(applied.state.stack.at(-1).blockId, "deliver");
  const execution = applied.state.plans["root/investigate"];
  assert.deepEqual(execution.results["fetch-data"].data, { value: 1 });
  assert.equal(execution.resultOperators["fetch-data"], "fetch");
  assert.equal(applied.state.invocations["root/investigate/fetch-data"].status, "succeeded");
  assert.equal(applied.state.checkpoints["root/investigate/fetch-data"], undefined, "successful plan nodes keep one result shape");
});

test("a failing exit applies the plan's recovery policy, remains restorable, and retries in place", () => {
  const base = processWorkflow({ output: "fetch-report" }, { recovery: { maxAttempts: 2, strategy: ["retry", "block"] } });
  const wf = { ...base, contracts: new Map([["fetch-report", contractOf("fetch-report", { type: "object", required: ["value"] })]]) };
  let state = start(wf, { runId: "r1" }).state;
  state = toProcessNode(wf, state);
  const first = transition(wf, state, { type: "process-exit", key: "root/investigate/fetch-data", exit: exit({ code: 1, stdout: "" }) });
  assert.ok(first.ok, first.error);
  assert.equal(first.effect.kind, "deliver", "retry keeps the run on the node");
  assert.equal(first.state.stack.at(-1).key, "root/investigate/fetch-data");
  assert.equal(first.state.invocations["root/investigate/fetch-data"].attempt, 2);
  const second = transition(wf, first.state, { type: "process-exit", key: "root/investigate/fetch-data", exit: exit({ code: 1, stdout: "" }) });
  assert.ok(second.ok, second.error);
  assert.equal(second.effect.kind, "stay", "after retries are exhausted the run parks");
  assert.equal(second.state.invocations["root/investigate/fetch-data"].status, "waiting");
  assert.match(second.state.checkpoints["root/investigate/fetch-data"].summary, /exited with code 1/);
  const restored = validateAgainstWorkflow(wf, second.state);
  assert.ok(restored.ok, restored.ok ? "" : restored.error);
  const recovered = transition(wf, second.state, { type: "process-exit", key: "root/investigate/fetch-data", exit: exit() });
  assert.ok(recovered.ok, recovered.ok ? "" : recovered.error);
  assert.equal(recovered.state.checkpoints["root/investigate/fetch-data"], undefined, "success removes the failure checkpoint after a manual retry");
});

test("a contract violation applies recovery instead of failing the engine", () => {
  const wf = processWorkflow(
    { output: "fetch-report" },
    {},
  );
  const contracts = new Map(wf.contracts);
  contracts.set("fetch-report", contractOf("fetch-report", { type: "object", required: ["value"] }));
  const withContracts = { ...wf, contracts };
  let state = start(withContracts, { runId: "r1" }).state;
  state = toProcessNode(withContracts, state);
  const applied = transition(withContracts, state, {
    type: "process-exit",
    key: "root/investigate/fetch-data",
    exit: exit({ stdout: '{"other":true}' }),
  });
  assert.ok(applied.ok, applied.error);
  assert.equal(applied.effect.kind, "deliver", "the contract violation became a retry");
  assert.equal(applied.state.plans["root/investigate"].results["fetch-data"], undefined);
});

test("oversized contracted output publishes a validated artifact reference", () => {
  const wf = processWorkflow({ output: "fetch-report" });
  const contracts = new Map(wf.contracts);
  contracts.set("fetch-report", contractOf("fetch-report", { type: "object", required: ["value"], properties: { value: { type: "string" } } }));
  const withContracts = { ...wf, contracts };
  const store = memoryStore();
  let state = start(withContracts, { runId: "r1" }).state;
  state = toProcessNode(withContracts, state);
  const key = "root/investigate/fetch-data";
  const value = { value: "x".repeat(9_000) };
  const applied = transition(withContracts, state, {
    type: "process-exit",
    key,
    exit: exit({ stdout: JSON.stringify(value) }),
    store: store.sinkFor(key),
  }, store);
  assert.ok(applied.ok, applied.error);
  const result = applied.state.plans["root/investigate"].results["fetch-data"];
  assert.ok(isArtifactRef(result.data), "the 8 KiB plan-result budget publishes the validated value");
  assert.equal(store.published.at(-1).value.value.length, 9_000);
  const restored = validateAgainstWorkflow(withContracts, applied.state);
  assert.ok(restored.ok, restored.ok ? "" : restored.error);
});

test("an operator without a script still runs as an agent node", () => {
  const wf = workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }], {
    operators: new Map([["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect." }]]),
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", { plan: { version: 1, nodes: [{ id: "a", operator: "inspect", objective: "A.", done: ["a-done"] }, { id: "b", operator: "inspect", objective: "B.", done: ["b-done"] }] } })),
  }).state;
  assert.equal(state.invocations["root/investigate/a"].runner, "agent");
});
