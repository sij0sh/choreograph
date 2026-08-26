import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { validateAgainstWorkflow } from "../../src/persistence/migrate.ts";
import { completed, cp, needsWork, task, workflow } from "./helpers.mjs";

const INSPECT = { id: "inspect", path: "operators/inspect.md", description: "Inspect." };

function planNodes(prefix = "") {
  return [
    { id: `${prefix}a`, operator: "inspect", objective: "Inspect the entry.", done: [`${prefix}a-done`] },
    { id: `${prefix}b`, operator: "inspect", objective: "Trace the entry.", dependsOn: [`${prefix}a`], done: [`${prefix}b-done`] },
  ];
}

function createPlan(nodes = planNodes()) {
  return completed(cp("planned", { plan: { version: 1, nodes } }));
}

function taskRecovery() {
  return { maxAttempts: 1, maxReplans: 2, strategy: ["invalidate", "block"] };
}

test("invalidating a task removes its binding consumers and rewinds to the producer", () => {
  const wf = workflow([
    task("frame"),
    task("verify", { inputs: { contract: { from: "frame" } }, recovery: taskRecovery() }),
  ], { inputEdges: { verify: ["frame"] } });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  const result = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("stale"), [{ target: "frame", reason: "the framing is stale" }]),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.state.stack.at(-1).blockId, "frame");
  assert.equal(result.state.checkpoints["root/frame"], undefined);
  assert.equal(result.state.checkpoints["root/verify"], undefined);
});

test("invalidating a plan node removes downstream task artifacts", () => {
  const operators = new Map([["inspect", INSPECT]]);
  const wf = workflow([
    task("frame"),
    { kind: "plan", id: "investigate", operators: ["inspect"] },
    task("verify", { inputs: { findings: { from: "investigate" } } }),
    task("report", { inputs: { findings: { from: "investigate" } } }),
    task("audit", { inputs: { findings: { from: "investigate" } }, recovery: taskRecovery() }),
  ], {
    operators,
    inputEdges: { verify: ["investigate"], report: ["investigate"], audit: ["investigate"] },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: createPlan() }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["a-done"], checkpoint: cp("a") } }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["b-done"], checkpoint: cp("b") } }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("verified")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("reported")) }).state;
  assert.equal(state.stack.at(-1).blockId, "audit");
  assert.ok(state.checkpoints["root/verify"]);
  assert.ok(state.checkpoints["root/report"]);

  const result = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("the source result is stale"), [{ target: "a", reason: "bad evidence" }]),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.state.stack.at(-1).kind, "node");
  assert.equal(result.state.stack.at(-1).nodeId, "a");
  assert.equal(result.state.plans["root/investigate"].results.a, undefined);
  assert.equal(result.state.plans["root/investigate"].results.b, undefined);
  assert.equal(result.state.checkpoints["root/verify"], undefined);
  assert.equal(result.state.checkpoints["root/report"], undefined);
});

test("invalidating a plan resets a downstream plan that consumes its aggregate", () => {
  const operators = new Map([["inspect", INSPECT]]);
  const downstreamRecovery = { maxAttempts: 2, maxReplans: 2, strategy: ["retry", "invalidate", "replan", "block"] };
  const wf = workflow([
    task("frame"),
    { kind: "plan", id: "source", operators: ["inspect"] },
    { kind: "plan", id: "derived", operators: ["inspect"], recovery: downstreamRecovery },
    task("audit", { recovery: taskRecovery() }),
  ], {
    operators,
    inputEdges: { derived: ["source"], audit: ["source"] },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: createPlan(planNodes("source-")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["source-a-done"], checkpoint: cp("source-a") } }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["source-b-done"], checkpoint: cp("source-b") } }).state;
  state = transition(wf, state, { type: "outcome", outcome: createPlan(planNodes("derived-")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["derived-a-done"], checkpoint: cp("derived-a") } }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["derived-b-done"], checkpoint: cp("derived-b") } }).state;
  assert.equal(state.stack.at(-1).blockId, "audit");
  assert.deepEqual(Object.keys(state.plans["root/derived"].results), ["derived-a", "derived-b"]);

  const result = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("source is stale"), [{ target: "source-a", reason: "bad evidence" }]),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.state.stack.at(-1).nodeId, "source-a");
  assert.equal(result.state.plans["root/derived"].awaitingPlan, true);
  assert.deepEqual(result.state.plans["root/derived"].results, {});
  assert.equal(result.state.plans["root/derived"].invalidations, 1);

  state = transition(wf, result.state, { type: "outcome", outcome: { status: "completed", met: ["source-a-done"], checkpoint: cp("source-a-2") } }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["source-b-done"], checkpoint: cp("source-b-2") } }).state;
  assert.equal(state.stack.at(-1).kind, "plan");
  assert.equal(state.stack.at(-1).mode, "create");
  assert.equal(state.stack.at(-1).blockId, "derived");
});

test("restore rejects persisted artifacts that no longer satisfy their contracts", () => {
  const wf = workflow([task("frame", { output: "contract" }), task("deliver")], {
    contracts: { contract: { type: "object", required: ["objective"], properties: { objective: { type: "string" } } } },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { objective: "valid" })) }).state;
  assert.equal(validateAgainstWorkflow(wf, state).ok, true);
  const invalid = {
    ...state,
    checkpoints: { ...state.checkpoints, "root/frame": cp("stale", {}) },
  };
  const restored = validateAgainstWorkflow(wf, invalid);
  assert.equal(restored.ok, false);
  assert.match(restored.error, /checkpoint root\/frame violates contract contract/);
});

test("restore rejects retained plan results without producer metadata", () => {
  const operators = new Map([["inspect", { ...INSPECT, output: "finding" }]]);
  const wf = workflow([{ kind: "plan", id: "investigate", operators: ["inspect"] }], {
    operators,
    contracts: { finding: { type: "object", required: ["summary"] } },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: createPlan() }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["a-done"], checkpoint: cp("found", { summary: "valid" }) },
  }).state;
  const invalid = {
    ...state,
    plans: {
      ...state.plans,
      "root/investigate": {
        ...state.plans["root/investigate"],
        plan: { version: 1, nodes: [{ id: "b", operator: "inspect", objective: "b", dependsOn: ["a"], done: ["b-done"] }] },
        results: { a: state.plans["root/investigate"].results.a },
        resultOperators: {},
      },
    },
  };
  const restored = validateAgainstWorkflow(wf, invalid);
  assert.equal(restored.ok, false);
  assert.match(restored.error, /retained result root\/investigate\/a has no producer metadata/);
});

test("restore rejects a plan-node artifact that no longer satisfies its operator contract", () => {
  const operators = new Map([["inspect", { ...INSPECT, output: "finding" }]]);
  const wf = workflow([{ kind: "plan", id: "investigate", operators: ["inspect"] }, task("deliver")], {
    operators,
    contracts: { finding: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: createPlan() }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["a-done"], checkpoint: cp("found", { summary: "valid" }) },
  }).state;
  const invalid = {
    ...state,
    plans: {
      ...state.plans,
      "root/investigate": {
        ...state.plans["root/investigate"],
        results: { ...state.plans["root/investigate"].results, a: cp("stale", {}) },
      },
    },
  };
  const restored = validateAgainstWorkflow(wf, invalid);
  assert.equal(restored.ok, false);
  assert.match(restored.error, /node result root\/investigate\/a violates contract finding/);
});
