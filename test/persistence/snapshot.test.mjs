import test from "node:test";
import assert from "node:assert/strict";
import { activeSnapshot, parseSnapshot, terminalSnapshot } from "../../src/persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../../src/persistence/migrate.ts";
import { latestSnapshot } from "../../src/persistence/store.ts";
import { completed, cp, loop, needsWork, sequence, task, workflow } from "../engine/helpers.mjs";
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
  assert.equal(parsed.v, 5);
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

test("terminal snapshots keep the version and tolerate a final execution", () => {
  const { wf, state } = midRunState();
  const completedState = { ...state, stack: [], status: "completed" };
  const snapshot = terminalSnapshot("completed", wf.name, "run-1", completedState);
  assert.equal(snapshot.v, 5);
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "terminal");
  const abortedState = { ...state, status: "aborted" };
  const aborted = parseSnapshot(JSON.parse(JSON.stringify(terminalSnapshot("aborted", wf.name, "run-1", abortedState))));
  assert.equal(aborted.status, "terminal");
});

test("pre-version-5 active snapshots report as invalid", () => {
  const stale = parseSnapshot({ v: 3, status: "active", workflow: "demo", runId: "r1", position: { kind: "step", stepId: "frame" }, target: "", delivered: false, memory: { steps: {} } });
  assert.equal(stale.status, "invalid");
  assert.match(stale.error, /version must be 5/);
});

test("invalid snapshots never partially resume", () => {
  const invalid = parseSnapshot({ v: 5, status: "active", workflow: "demo", execution: { status: "active", stack: [{ kind: "task" }] }, delivered: false });
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
  const branch = [entry({ v: 5, status: "aborted", workflow: "demo", runId: "old" }), entry(snap), { type: "user", text: "hi" }];
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

test("persisted plan results are validated entry by entry", () => {
  const wf = workflow([task("frame"), { kind: "plan", id: "investigate", operators: [] }]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  const withResults = structuredClone(state);
  withResults.plans = {
    "root/investigate": {
      blockId: "investigate",
      revision: 1,
      replans: 0,
      invalidations: 0,
      plan: { version: 1, nodes: [{ id: "node-a", operator: "inspect", objective: "o", done: ["a-done"] }] },
      results: { "node-a": 42 },
    },
  };
  const garbage = parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: withResults, delivered: true }))));
  assert.equal(garbage.status, "invalid");
  assert.match(garbage.error, /results\.node-a/);

  const validResults = structuredClone(withResults);
  validResults.plans["root/investigate"].results = { "node-a": { summary: "done" } };
  const valid = parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: validResults, delivered: true }))));
  assert.equal(valid.status, "active");
});

test("checkpointOrder round-trips and legacy snapshots infer insertion order", () => {
  const wf = workflow([task("zeta"), task("alpha"), task("omega")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("ZETA-SUMMARY")) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("ALPHA-SUMMARY")) }).state;
  assert.deepEqual(state.checkpointOrder, ["root/zeta", "root/alpha"], "order records write order, not spelling");

  const snapshot = JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: true })));
  const withOrder = parseSnapshot(snapshot);
  assert.deepEqual(withOrder.execution.checkpointOrder, ["root/zeta", "root/alpha"]);

  delete snapshot.execution.checkpointOrder;
  const legacy = parseSnapshot(snapshot);
  assert.equal(legacy.status, "active");
  assert.deepEqual(legacy.execution.checkpointOrder, ["root/zeta", "root/alpha"], "legacy v4 snapshots infer JSON insertion order");

  snapshot.execution.checkpointOrder = ["root/alpha", "root/ghost"];
  const dangling = parseSnapshot(snapshot);
  assert.equal(dangling.status, "invalid");
  assert.match(dangling.error, /checkpointOrder/);
});

test("skipped checkpoints round-trip and stay resumable", () => {
  const wf = workflow([
    task("frame"),
    task("deep", { guard: { from: "frame", op: "exists", select: "/data/missing" } }),
    task("deliver"),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { note: "no findings" })) }).state;
  assert.equal(state.stack.at(-1).blockId, "deliver");
  const skipped = state.checkpoints["root/deep"];
  assert.equal(skipped.skipped, true);

  const roundTrip = parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: false }))));
  assert.equal(roundTrip.status, "active");
  assert.equal(roundTrip.execution.checkpoints["root/deep"].skipped, true);
});

test("a mid-loop snapshot round-trips and resumes the exact iteration", () => {
  const wf = workflow([task("gather"), loop("review", "for-each"), task("deliver")]);
  let state = start(wf, { runId: "run-9", target: "repo" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("gathered", { files: ["a", "b", "c"] })) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("reviewed a")) }).state;
  assert.equal(state.stack.at(-1).key, "root/review/loop[2]/review-step");
  const snapshot = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  assert.deepEqual(parsed.execution, state);
  assert.equal(parsed.execution.loops["root/review"].iteration, 2);
  assert.deepEqual(parsed.execution.loops["root/review"].items, ["a", "b", "c"]);
  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);
  const next = transition(wf, parsed.execution, { type: "outcome", outcome: completed(cp("reviewed b")) });
  assert.ok(next.ok);
  assert.equal(next.state.stack.at(-1).key, "root/review/loop[3]/review-step");
});

test("loop snapshots reject out-of-range iterations and orphan loop state", () => {
  const wf = workflow([task("gather"), loop("review", "for-each", { maxIterations: 2 }), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: ["a"] })) }).state;
  const snapshot = JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: true })));
  snapshot.execution.loops["root/review"].iteration = 9;
  snapshot.execution.stack[1].scopeId = "loop[9]";
  snapshot.execution.stack[2].key = "root/review/loop[9]";
  snapshot.execution.stack[2].index = 0;
  const outOfRange = parseSnapshot(snapshot);
  assert.equal(outOfRange.status, "invalid");
  assert.match(outOfRange.error, /iteration must be between 1 and 8/);
  const snapshot2 = JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: true })));
  snapshot2.execution.loops["root/orphan"] = { iteration: 1 };
  const orphan = parseSnapshot(snapshot2);
  assert.equal(orphan.status, "invalid");
  assert.match(orphan.error, /no matching loop frame/);
});

test("a loop-free v5 snapshot restores identically alongside loop support", () => {
  const { wf, state } = midRunState();
  const snapshot = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  assert.deepEqual(parsed.execution, state);
  assert.deepEqual(parsed.execution.loops, {});
});

test("a parked active snapshot round-trips and a parked:false marker is omitted", () => {
  const { wf, state } = midRunState();
  const parked = activeSnapshot({ workflow: wf.name, execution: state, delivered: false, parked: true });
  const parsedParked = parseSnapshot(JSON.parse(JSON.stringify(parked)));
  assert.equal(parsedParked.status, "active");
  assert.equal(parsedParked.parked, true, "the parked marker survives the round trip");

  const plain = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const data = JSON.parse(JSON.stringify(plain));
  assert.equal("parked" in data, false, "unparked snapshots carry no parked field");
  const parsedPlain = parseSnapshot(data);
  assert.equal(parsedPlain.parked, undefined);

  const rejected = parseSnapshot({ ...data, parked: "yes" });
  assert.equal(rejected.status, "invalid", "a non-boolean parked marker is rejected");
});

test("a definition digest and typed invocations round-trip through v5 snapshots", () => {
  const { wf, state } = midRunState();
  const withFields = {
    ...state,
    definitionDigest: "a".repeat(64),
    invocations: { "root/probe": { blockId: "probe", key: "root/probe", runner: "process", status: "waiting", attempt: 2 } },
  };
  const snapshot = activeSnapshot({ workflow: wf.name, execution: withFields, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  assert.equal(parsed.execution.definitionDigest, "a".repeat(64));
  assert.deepEqual(parsed.execution.invocations, withFields.invocations);

  const data = JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: false })));
  assert.equal("definitionDigest" in data.execution, false, "digestless runs omit the field");
  assert.equal("invocations" in data.execution, false, "runs without invocations omit the field");
});

test("snapshot validation rejects malformed invocations and digests", () => {
  const { wf, state } = midRunState();
  const build = (execution) => parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution, delivered: false }))));
  const badStatus = build({ ...state, invocations: { "root/probe": { blockId: "probe", key: "root/probe", runner: "process", status: "mostly-fine", attempt: 1 } } });
  assert.equal(badStatus.status, "invalid");
  assert.match(badStatus.error, /status must be one of/);
  const badRunner = build({ ...state, invocations: { "root/probe": { blockId: "probe", key: "root/probe", runner: "cron", status: "running", attempt: 1 } } });
  assert.equal(badRunner.status, "invalid");
  assert.match(badRunner.error, /runner must be one of/);
  const badKey = build({ ...state, invocations: { "root/probe": { blockId: "probe", key: "root/other", runner: "process", status: "running", attempt: 1 } } });
  assert.equal(badKey.status, "invalid");
  assert.match(badKey.error, /must match its map key/);
  const badAttempt = build({ ...state, invocations: { "root/probe": { blockId: "probe", key: "root/probe", runner: "process", status: "running", attempt: 9 } } });
  assert.equal(badAttempt.status, "invalid");
  assert.match(badAttempt.error, /attempt must be an integer/);
  const badDigest = build({ ...state, definitionDigest: 7 });
  assert.equal(badDigest.status, "invalid");
  assert.match(badDigest.error, /definitionDigest must be a string/);
  const stray = build({ ...state, invocations: { "root/probe": { blockId: "probe", key: "root/probe", runner: "process", status: "running", attempt: 1, extra: 1 } } });
  assert.equal(stray.status, "invalid");
  assert.match(stray.error, /not an accepted invocation field/);
});
