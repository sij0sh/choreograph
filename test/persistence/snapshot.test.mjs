import test from "node:test";
import assert from "node:assert/strict";
import { activeSnapshot, parseSnapshot, terminalSnapshot } from "../../src/persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../../src/persistence/migrate.ts";
import { latestSnapshot } from "../../src/persistence/store.ts";
import { completed, cp, needsWork, sequence, task, workflow } from "../engine/helpers.mjs";
import { start, transition } from "../../src/engine/interpreter.ts";
import { LIMITS } from "../../src/domain/limits.ts";

function steppedWorkflow() {
  return workflow([task("discover"), task("inspect"), task("deliver")]);
}

function midRunState() {
  const wf = steppedWorkflow();
  let state = start(wf, { runId: "run-1", target: "repo" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found")) }).state;
  return { wf, state };
}

test("an active snapshot round-trips through JSON and resumes", () => {
  const { wf, state } = midRunState();
  const snapshot = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  assert.equal(parsed.v, 4);
  assert.deepEqual(parsed.execution, state);

  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);

  let resumed = parsed.execution;
  const next = transition(wf, resumed, { type: "outcome", outcome: completed(cp("inspected a")) });
  assert.ok(next.ok);
  resumed = next.state;
  assert.equal(resumed.stack.at(-1).blockId, "deliver", "the resumed run finishes its exact remaining steps");
});

test("task and plan frames round-trip", () => {
  const wf = workflow([task("discover"), { kind: "plan", id: "investigate", operators: [] }]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found")) }).state;
  assert.deepEqual(state.stack.map((f) => f.kind), ["sequence", "plan"]);
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: true }))));
  assert.deepEqual(parsed.execution, state);
  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);
});

const PLAN_OPERATORS = new Map([
  ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ["trace", { id: "trace", path: "operators/trace.md", description: "Trace flow." }],
]);

function planRecoveryWorkflow() {
  return workflow(
    [
      task("frame"),
      {
        kind: "plan",
        id: "investigate",
        operators: ["inspect", "trace"],
        recovery: { maxAttempts: 3, maxReplans: 2, strategy: ["retry", "replan"] },
      },
    ],
    { operators: PLAN_OPERATORS },
  );
}

function createAttemptState() {
  const wf = planRecoveryWorkflow();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", {
      plan: {
        version: 1,
        nodes: [
          { id: "probe", operator: "inspect", objective: "Probe.", done: ["probe-done"] },
          { id: "map", operator: "trace", objective: "Map.", done: ["map-done"] },
        ],
      },
    })),
  }).state;
  return { wf, state };
}

test("plan-create attempt four round-trips and stays resumable", () => {
  const { wf, state: created } = createAttemptState();
  let state = created;
  for (let i = 0; i < 5; i += 1) {
    const stepped = transition(wf, state, { type: "outcome", outcome: needsWork(cp(`nw ${i + 1}`)) });
    assert.ok(stepped.ok, stepped.ok ? "" : stepped.error);
    state = stepped.state;
  }
  const leaf = state.stack.at(-1);
  assert.equal(leaf.kind, "plan");
  assert.equal(leaf.mode, "create");
  assert.equal(leaf.attempt, 4);
  const snapshot = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  assert.equal(parsed.execution.stack.at(-1).attempt, 4);
  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);

  const beyond = structuredClone(state);
  beyond.stack[beyond.stack.length - 1] = { ...beyond.stack.at(-1), attempt: 5 };
  const rejected = parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: beyond, delivered: false }))));
  assert.equal(rejected.status, "invalid");
  assert.match(rejected.error, /between 0 and 4/);
});

test("task, node, and execute-plan attempts keep the single-dimension bound", () => {
  const { wf, state } = createAttemptState();
  const roundTrip = (execution) => parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution, delivered: false }))));
  const taskFour = structuredClone(start(wf, { runId: "r1" }).state);
  taskFour.stack[taskFour.stack.length - 1] = { ...taskFour.stack.at(-1), attempt: 4 };
  assert.equal(roundTrip(taskFour).status, "invalid");
  const nodeFour = structuredClone(state);
  nodeFour.stack[nodeFour.stack.length - 1] = { ...nodeFour.stack.at(-1), attempt: 4 };
  assert.equal(roundTrip(nodeFour).status, "invalid");
  const executeFour = structuredClone(state);
  const planIndex = executeFour.stack.findIndex((frame) => frame.kind === "plan");
  executeFour.stack[planIndex] = { ...executeFour.stack[planIndex], attempt: 4 };
  assert.equal(roundTrip(executeFour).status, "invalid");
});

test("terminal snapshots parse as terminal", () => {
  assert.equal(parseSnapshot(terminalSnapshot("completed", "demo", "r1")).status, "terminal");
  const legacy = parseSnapshot({ v: 3, status: "completed", workflow: "demo", runId: "r1", totalSteps: 4 });
  assert.equal(legacy.status, "terminal");
});

test("pre-version-4 active snapshots report as invalid", () => {
  const stale = parseSnapshot({ v: 3, status: "active", workflow: "demo", runId: "r1", position: { kind: "step", stepId: "frame" }, target: "", delivered: false, memory: { steps: {} } });
  assert.equal(stale.status, "invalid");
  assert.match(stale.error, /version must be 4/);
});

test("invalid snapshots never partially resume", () => {
  const invalid = parseSnapshot({ v: 4, status: "active", workflow: "demo", execution: { status: "active", stack: [{ kind: "task" }] }, delivered: false });
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.error, /blockId/);
  const notAnObject = parseSnapshot("nope");
  assert.equal(notAnObject, null);
});

test("semantic restore rejects stale positions", () => {
  const { wf, state } = midRunState();
  const edited = workflow([
    task("discover"),
    task("renamed"),
    task("deliver"),
  ]);
  const drifted = validateAgainstWorkflow(edited, state);
  assert.ok(!drifted.ok);
  assert.match(drifted.error, /child/);

  const removed = workflow([task("discover"), task("deliver")]);
  const gone = validateAgainstWorkflow(removed, state);
  assert.ok(!gone.ok);

  const renamedRoot = workflow([task("discover"), task("deliver")], { rootId: "main" });
  const wrongRoot = validateAgainstWorkflow(renamedRoot, state);
  assert.ok(!wrongRoot.ok);
  assert.match(wrongRoot.error, /root sequence/);
});

test("latestSnapshot finds the newest custom entry on the branch", () => {
  const entry = (data) => ({ type: "custom", customType: "choreograph", data });
  const { state } = midRunState();
  const snap = activeSnapshot({ workflow: "demo", execution: state, delivered: true });
  const branch = [entry({ v: 4, status: "aborted", workflow: "demo", runId: "old" }), entry(snap), { type: "user", text: "hi" }];
  const parsed = latestSnapshot(branch);
  assert.equal(parsed.status, "active");
  assert.equal(parsed.execution.runId, "run-1");
  assert.equal(latestSnapshot([{ type: "custom", customType: "other", data: {} }]), null);
});

test("latestSnapshot ignores snapshots persisted under the pre-rename type", () => {
  const { state } = midRunState();
  const snap = activeSnapshot({ workflow: "demo", execution: state, delivered: true });
  const parsed = latestSnapshot([{ type: "custom", customType: "pi-workflows", data: snap }]);
  assert.equal(parsed, null);
});
