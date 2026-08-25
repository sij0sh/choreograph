import test from "node:test";
import assert from "node:assert/strict";
import { activeSnapshot, parseSnapshot, terminalSnapshot } from "../../src/persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../../src/persistence/migrate.ts";
import { latestSnapshot } from "../../src/persistence/store.ts";
import { completed, cp, sequence, task, workflow } from "../engine/helpers.mjs";
import { start, transition } from "../../src/engine/interpreter.ts";

function forEachWorkflow() {
  const body = sequence("body", [task("inspect")]);
  return workflow([
    task("discover"),
    { kind: "foreach", id: "review", items: { root: "discover", path: ["files"] }, as: "file", body },
    task("deliver"),
  ]);
}

function midLoopState() {
  const wf = forEachWorkflow();
  let state = start(wf, { runId: "run-1", target: "repo" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["a", "b", "c"] })) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("inspected a")) }).state;
  return { wf, state };
}

test("an active snapshot round-trips through JSON and resumes", () => {
  const { wf, state } = midLoopState();
  const snapshot = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(parsed.status, "active");
  assert.equal(parsed.v, 4);
  assert.deepEqual(parsed.execution, state);

  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);

  let resumed = parsed.execution;
  const next = transition(wf, resumed, { type: "outcome", outcome: completed(cp("inspected b")) });
  assert.ok(next.ok);
  resumed = next.state;
  const last = transition(wf, resumed, { type: "outcome", outcome: completed(cp("inspected c")) });
  assert.ok(last.ok);
  assert.equal(last.state.stack.at(-1).blockId, "deliver", "the resumed loop finishes its exact remaining iterations");
});

test("every frame type round-trips", () => {
  const innerBody = sequence("inner-body", [task("probe")]);
  const wf = workflow([
    task("discover"),
    {
      kind: "foreach",
      id: "outer",
      items: { root: "discover", path: ["files"] },
      as: "file",
      body: sequence("outer-body", [
        {
          kind: "repeat",
          id: "retry-zone",
          max: 2,
          body: sequence("retry-body", [task("probe")]),
        },
      ]),
    },
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["x", "y"] })) }).state;
  assert.deepEqual(state.stack.map((f) => f.kind), ["sequence", "foreach", "sequence", "repeat", "sequence", "task"]);
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(activeSnapshot({ workflow: wf.name, execution: state, delivered: true }))));
  assert.deepEqual(parsed.execution, state);
  const migrated = validateAgainstWorkflow(wf, parsed.execution);
  assert.ok(migrated.ok, migrated.ok ? "" : migrated.error);
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
  const { wf, state } = midLoopState();
  const edited = workflow([
    task("discover"),
    { kind: "foreach", id: "review", items: { root: "discover", path: ["files"] }, as: "renamed", body: sequence("body", [task("inspect")]) },
    task("deliver"),
  ]);
  const drifted = validateAgainstWorkflow(edited, state);
  assert.ok(!drifted.ok);
  assert.match(drifted.error, /variable/);

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
  const { state } = midLoopState();
  const snap = activeSnapshot({ workflow: "demo", execution: state, delivered: true });
  const branch = [entry({ v: 4, status: "aborted", workflow: "demo", runId: "old" }), entry(snap), { type: "user", text: "hi" }];
  const parsed = latestSnapshot(branch);
  assert.equal(parsed.status, "active");
  assert.equal(parsed.execution.runId, "run-1");
  assert.equal(latestSnapshot([{ type: "custom", customType: "other", data: {} }]), null);
});

test("latestSnapshot ignores snapshots persisted under the pre-rename type", () => {
  const { state } = midLoopState();
  const snap = activeSnapshot({ workflow: "demo", execution: state, delivered: true });
  const parsed = latestSnapshot([{ type: "custom", customType: "pi-workflows", data: snap }]);
  assert.equal(parsed, null);
});
