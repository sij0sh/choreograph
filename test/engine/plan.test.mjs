import test from "node:test";
import assert from "node:assert/strict";
import { start, transition, currentPosition } from "../../src/engine/interpreter.ts";
import { sequence, task, workflow } from "./helpers.mjs";

const OPERATORS = new Map([
  ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ["trace", { id: "trace", path: "operators/trace.md", description: "Trace flow." }],
]);

function planWorkflow(extraChildren = []) {
  return workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect", "trace"] }, ...extraChildren], {
    operators: OPERATORS,
  });
}

function plan(nodes) {
  return { version: 1, nodes };
}

function node(id, operator = "inspect", extra = {}) {
  return { id, operator, objective: `Objective for ${id}`, done: [`${id}-done`], ...extra };
}

function planCompletion(nodes) {
  return {
    status: "completed",
    checkpoint: { summary: "Planned.", data: { plan: plan(nodes) } },
  };
}

test("a plan block first delivers a creation position", () => {
  const wf = planWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "framed" } } }).state;
  assert.equal(state.stack.at(-1).kind, "plan");
  assert.equal(state.stack.at(-1).mode, "create");
  const position = currentPosition(wf, state);
  assert.equal(position.type, "plan-create");
  assert.deepEqual(position.plan.operators, ["inspect", "trace"]);
});

test("plan creation without data.plan fails closed", () => {
  const wf = planWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "framed" } } }).state;
  const result = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "no plan" } } });
  assert.ok(!result.ok);
  assert.match(result.error, /checkpoint\.data\.plan/);
});

test("an invalid plan reports every error and stays at creation", () => {
  const wf = planWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "framed" } } }).state;
  const result = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", checkpoint: { summary: "bad", data: { plan: plan([node("a", "warp"), node("a")]) } } },
  });
  assert.ok(!result.ok);
  assert.match(result.error, /trusted operators/);
  assert.match(result.error, /duplicates/);
  assert.equal(state.stack.at(-1).mode, "create", "state is unchanged after rejection");
});

test("a valid plan enters its first node and runs nodes in order", () => {
  const wf = planWorkflow([task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "framed" } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: planCompletion([node("probe"), node("map", "trace", { dependsOn: ["probe"] })]) }).state;

  const planKey = "root/investigate";
  assert.equal(state.stack.at(-1).kind, "node");
  assert.equal(state.stack.at(-1).nodeId, "probe");
  assert.equal(state.plans[planKey].revision, 1);

  const probePass = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["probe-done"], checkpoint: { summary: "probed", data: { found: 3 } } },
  });
  assert.ok(probePass.ok);
  assert.equal(probePass.state.stack.at(-1).nodeId, "map");
  assert.deepEqual(probePass.state.plans[planKey].results.probe.data, { found: 3 });

  const mapPass = transition(wf, probePass.state, {
    type: "outcome",
    outcome: { status: "completed", met: ["map-done"], checkpoint: { summary: "mapped" } },
  });
  assert.ok(mapPass.ok);
  assert.equal(mapPass.state.stack.at(-1).blockId, "deliver", "the parent sequence resumes after the plan completes");
  assert.equal(Object.keys(mapPass.state.plans[planKey].results).length, 2);
});

test("node completion is gated by node criteria", () => {
  const wf = planWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "framed" } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: planCompletion([node("probe"), node("map", "trace")]) }).state;
  const missing = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "half done" } } });
  assert.ok(!missing.ok);
  assert.match(missing.error, /missing: probe-done/);
});

test("a completed plan block is skipped on re-entry", () => {
  const body = sequence("body", [{ kind: "plan", id: "investigate", operators: ["inspect"] }]);
  const wf = workflow([task("discover"), { kind: "foreach", id: "loop", items: { root: "discover", path: ["files"] }, as: "file", body }], { operators: OPERATORS });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "found", data: { files: ["a"] } } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: planCompletion([node("probe"), node("seal")]) }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["probe-done"], checkpoint: { summary: "p" } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["seal-done"], checkpoint: { summary: "s" } } }).state;
  assert.equal(state.status, "completed", "the loop body finishes and the run completes");
});

test("plan nodes are keyed per loop iteration", () => {
  const body = sequence("body", [{ kind: "plan", id: "investigate", operators: ["inspect"] }]);
  const wf = workflow([task("discover"), { kind: "foreach", id: "loop", items: { root: "discover", path: ["files"] }, as: "file", body }], { operators: OPERATORS });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "found", data: { files: ["a", "b"] } } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: planCompletion([node("probe"), node("seal")]) }).state;
  assert.ok(state.plans["root/loop[0]/body/investigate"], "the first iteration gets its own plan key");
  assert.equal(state.stack.at(-1).key, "root/loop[0]/body/investigate/probe");
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["probe-done"], checkpoint: { summary: "p" } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["seal-done"], checkpoint: { summary: "s" } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: planCompletion([node("probe2"), node("seal2")]) }).state;
  assert.ok(state.plans["root/loop[1]/body/investigate"], "the second iteration plans afresh");
});

test("plan executions persist and restore through snapshots", async () => {
  const { activeSnapshot, parseSnapshot } = await import("../../src/persistence/snapshot.ts");
  const { validateAgainstWorkflow } = await import("../../src/persistence/migrate.ts");
  const wf = planWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", checkpoint: { summary: "framed" } } }).state;
  state = transition(wf, state, { type: "outcome", outcome: planCompletion([node("probe"), node("map", "trace")]) }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["probe-done"], checkpoint: { summary: "probed" } } }).state;

  const snapshot = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);
  const resumed = transition(wf, parsed.execution, {
    type: "outcome",
    outcome: { status: "completed", met: ["map-done"], checkpoint: { summary: "mapped" } },
  });
  assert.ok(resumed.ok);
  assert.equal(resumed.state.status, "completed");
});
