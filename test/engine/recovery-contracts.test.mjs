import test from "node:test";
import assert from "node:assert/strict";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { validateAgainstWorkflow } from "../../src/persistence/validate-stored-run.ts";
import { completed, cp, needsWork, task, workflow } from "./helpers.mjs";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


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
