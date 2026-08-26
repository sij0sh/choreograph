import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, needsWork, task, workflow } from "./helpers.mjs";

const OPERATORS = new Map([
  ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ["trace", { id: "trace", path: "operators/trace.md", description: "Trace flow." }],
]);

function node(id, operator = "inspect", extra = {}) {
  return { id, operator, objective: `Objective for ${id}`, done: [`${id}-done`], ...extra };
}

function planOf(nodes) {
  return { status: "completed", checkpoint: { summary: "Planned.", data: { plan: { version: 1, nodes } } } };
}

function passNode(id) {
  return { status: "completed", met: [`${id}-done`], checkpoint: { summary: `${id} done` } };
}

function planWorkflow(children, options = {}) {
  return workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect", "trace"], ...(options.plan ?? {}) }, ...children], {
    operators: OPERATORS,
  });
}

function seededPlan(wf, nodes) {
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: planOf(nodes) }).state;
  return state;
}

test("a node retries before any other recovery action", () => {
  const wf = planWorkflow([]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  const retry = transition(wf, state, { type: "outcome", outcome: needsWork(cp("thin evidence"), [{ target: "probe", reason: "no direct evidence" }]) });
  assert.ok(retry.ok);
  assert.equal(retry.effect.kind, "deliver");
  assert.equal(retry.state.stack.at(-1).nodeId, "probe");
  assert.equal(retry.state.stack.at(-1).attempt, 2);
});

test("a node escalates to replan after exhausting retries", () => {
  const wf = planWorkflow([]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("first try")) }).state;
  const replanned = transition(wf, state, { type: "outcome", outcome: needsWork(cp("second try")) });
  assert.ok(replanned.ok);
  const leaf = replanned.state.stack.at(-1);
  assert.equal(leaf.kind, "plan");
  assert.equal(leaf.mode, "create", "recovery returns to plan creation");
  const execution = Object.values(replanned.state.plans)[0];
  assert.equal(execution.revision, 2);
  assert.equal(execution.replans, 1);
  assert.deepEqual(Object.keys(execution.results), [], "nothing was completed to retain");
});

test("replan retains completed results and the new plan can depend on them", () => {
  const wf = planWorkflow([]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: passNode("probe") }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("map failed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("map failed again")) }).state;
  const execution = Object.values(state.plans)[0];
  assert.deepEqual(Object.keys(execution.results), ["probe"], "the completed result survives the replan");
  state = transition(wf, state, { type: "outcome", outcome: planOf([node("remap", "trace", { dependsOn: ["probe"] }), node("seal")]) }).state;
  assert.equal(state.stack.at(-1).nodeId, "remap");
  const after = Object.values(state.plans)[0];
  assert.deepEqual(Object.keys(after.results), ["probe"], "retained results persist into the new revision");
});

test("replan has a hard bound and then blocks with a resumable checkpoint", () => {
  const wf = planWorkflow([]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("one")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("two")) }).state;
  assert.equal(Object.values(state.plans)[0].replans, 1);
  state = transition(wf, state, { type: "outcome", outcome: planOf([node("fresh"), node("seal")]) }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("three")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("four")) }).state;
  assert.equal(Object.values(state.plans)[0].replans, 2);
  state = transition(wf, state, { type: "outcome", outcome: planOf([node("fresh2"), node("seal2")]) }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("five")) }).state;
  const blocked = transition(wf, state, { type: "outcome", outcome: needsWork(cp("six")) });
  assert.ok(blocked.ok);
  assert.equal(blocked.effect.kind, "stay", "the replan bound forces a blocked stay");
  assert.equal(blocked.state.status, "active");
  assert.ok(blocked.state.checkpoints[blocked.state.stack.at(-1).key], "blocking leaves a resumable checkpoint");
});

test("a verifier invalidates targeted results and their dependents, then resumes inside the plan", () => {
  const wf = planWorkflow([
    task("verify", {
      recovery: { maxAttempts: 2, maxReplans: 2, strategy: ["invalidate", "block"], scope: "investigate" },
    }),
  ]);
  let state = seededPlan(wf, [
    node("probe"),
    node("map", "trace", { dependsOn: ["probe"] }),
    node("confirm", "trace", { dependsOn: ["map"] }),
    node("independent"),
  ]);
  state = transition(wf, state, { type: "outcome", outcome: passNode("probe") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("map") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("confirm") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("independent") }).state;
  assert.equal(state.stack.at(-1).blockId, "verify", "the verifier follows the plan");

  const invalidation = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("probe evidence is weak"), [{ target: "probe", reason: "missing direct evidence" }]),
  });
  assert.ok(invalidation.ok, invalidation.ok ? "" : invalidation.error);
  const leaf = invalidation.state.stack.at(-1);
  assert.equal(leaf.kind, "node");
  assert.equal(leaf.nodeId, "probe", "execution resumes at the earliest invalidated node");
  const execution = Object.values(invalidation.state.plans)[0];
  assert.deepEqual(Object.keys(execution.results), ["independent"], "dependents invalidate transitively");
  assert.equal(execution.invalidations, 1);
});

test("the verifier runs again after the repaired plan completes", () => {
  const wf = planWorkflow([
    task("verify", {
      recovery: { maxAttempts: 2, maxReplans: 2, strategy: ["invalidate", "block"], scope: "investigate" },
    }),
  ]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace", { dependsOn: ["probe"] })]);
  state = transition(wf, state, { type: "outcome", outcome: passNode("probe") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("map") }).state;
  state = transition(wf, state, { type: "outcome", outcome: needsWork(cp("weak"), [{ target: "probe", reason: "thin" }]) }).state;
  assert.equal(state.stack.at(-1).nodeId, "probe");
  state = transition(wf, state, { type: "outcome", outcome: passNode("probe") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("map") }).state;
  assert.equal(state.stack.at(-1).blockId, "verify", "the sequence re-delivers the verifier after the plan");
});

test("needs-work can invalidate an earlier task checkpoint and re-run it", () => {
  const wf = workflow([
    task("gather"),
    task("verify", { recovery: { maxAttempts: 2, maxReplans: 0, strategy: ["invalidate", "block"] } }),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("gathered")) }).state;
  const invalidation = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("gather output is stale"), [{ target: "gather", reason: "missed the main module" }]),
  });
  assert.ok(invalidation.ok, invalidation.ok ? "" : invalidation.error);
  assert.equal(invalidation.state.stack.at(-1).blockId, "gather", "the run rewinds to the invalidated task");
  assert.equal(Object.keys(invalidation.state.checkpoints).length, 0, "the stale checkpoint is removed");
});

test("plan creation retries and then blocks", () => {
  const wf = planWorkflow([]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  const retry = transition(wf, state, { type: "outcome", outcome: needsWork(cp("cannot plan yet")) });
  assert.ok(retry.ok);
  assert.equal(retry.state.stack.at(-1).attempt, 2);
  const blocked = transition(wf, retry.state, { type: "outcome", outcome: needsWork(cp("still stuck")) });
  assert.ok(blocked.ok);
  assert.equal(blocked.effect.kind, "stay");
  assert.ok(blocked.state.checkpoints["root/investigate"]);
});

test("plan-create attempts accumulate across retries and replans, then block", () => {
  const wf = planWorkflow([], { plan: { recovery: { maxAttempts: 3, maxReplans: 2, strategy: ["retry", "replan"] } } });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: planOf([node("probe"), node("map", "trace")]) }).state;
  const trace = [];
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = transition(wf, state, { type: "outcome", outcome: needsWork(cp(`attempt ${i + 1}`)) });
    assert.ok(last.ok, last.ok ? "" : last.error);
    state = last.state;
    const leaf = state.stack.at(-1);
    trace.push(leaf.kind === "plan" ? `create@${leaf.attempt}` : `${leaf.kind}@${leaf.attempt}`);
  }
  assert.deepEqual(trace, ["node@2", "node@3", "create@2", "create@3", "create@4", "create@4"]);
  assert.equal(last.effect.kind, "stay", "the combined budget ends in a blocked stay");
  assert.equal(Object.values(state.plans)[0].replans, 2);
});

test("needs-work without matching targets falls through to block", () => {
  const wf = planWorkflow([
    task("verify", { recovery: { maxAttempts: 2, maxReplans: 2, strategy: ["invalidate", "replan", "block"], scope: "investigate" } }),
  ]);
  let state = seededPlan(wf, [node("probe"), node("map", "trace")]);
  state = transition(wf, state, { type: "outcome", outcome: passNode("probe") }).state;
  state = transition(wf, state, { type: "outcome", outcome: passNode("map") }).state;
  const replanned = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("everything looks wrong"), [{ target: "ghost-node", reason: "not a result" }]),
  });
  assert.ok(replanned.ok);
  assert.equal(replanned.state.stack.at(-1).mode, "create", "unmatched invalidation falls through to replan");
  assert.equal(Object.values(replanned.state.plans)[0].replans, 1);
});
