import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { validateAgainstWorkflow } from "../../src/persistence/validate-stored-execution.ts";
import { completed, cp, needsWork, script, task, workflow } from "./helpers.mjs";

const INSPECT = { id: "inspect", path: "operators/inspect.md", description: "Inspect." };
const PLAN = { version: 1, nodes: [
  { id: "probe", operator: "inspect", objective: "Find it.", done: ["probe-done"] },
  { id: "trace", operator: "inspect", objective: "Trace it.", dependsOn: ["probe"], done: ["trace-done"] },
] };

function guard(from, op, value, select) {
  return { from, op, ...(value !== undefined ? { value } : {}), ...(select ? { select } : {}) };
}

test("a false guard skips the task and records a skipped checkpoint", () => {
  const wf = workflow([
    task("frame"),
    task("deep", { guard: guard("frame", "equals", "high", "/data/severity") }),
    task("deliver"),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { severity: "low" })) }).state;
  assert.equal(state.stack.at(-1).blockId, "deliver");
  const skipped = state.checkpoints["root/deep"];
  assert.equal(skipped.skipped, true);
  assert.match(skipped.summary, /Skipped/);
});

test("a true guard runs the task normally", () => {
  const wf = workflow([
    task("frame"),
    task("deep", { guard: guard("frame", "equals", "high", "/data/severity") }),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { severity: "high" })) }).state;
  assert.equal(state.stack.at(-1).blockId, "deep");
  assert.equal(state.checkpoints["root/deep"], undefined);
});

test("skipping the last step completes the run", () => {
  const wf = workflow([
    task("frame"),
    task("deep", { guard: guard("frame", "gt", 5, "/data/count") }),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { count: 3 })) });
  assert.ok(result.ok);
  assert.equal(result.state.status, "completed");
  assert.equal(result.effect.kind, "complete");
});

test("consecutive guarded steps can all skip", () => {
  const wf = workflow([
    task("frame"),
    task("one", { guard: guard("frame", "exists", undefined, "/data/missing") }),
    task("two", { guard: guard("frame", "not-exists", undefined, "/data/severity") }),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { severity: "low" })) });
  assert.ok(result.ok);
  assert.equal(result.state.status, "completed");
  assert.equal(result.state.checkpoints["root/one"].skipped, true);
  assert.equal(result.state.checkpoints["root/two"].skipped, true);
});

test("guards see plan aggregates and not-in works", () => {
  const operators = new Map([["inspect", INSPECT]]);
  const wf = workflow([
    { kind: "plan", id: "investigate", operators: ["inspect"] },
    task("escalate", { guard: guard("investigate", "in", ["critical"], "/nodes/0/result/data/risk") }),
  ], { operators });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("planned", { plan: PLAN })) }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["probe-done"], checkpoint: cp("probed", { risk: "low" }) },
  }).state;
  assert.equal(state.stack.at(-1).nodeId, "trace");
  const result = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["trace-done"], checkpoint: cp("traced", { risk: "low" }) },
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.state.status, "completed");
  assert.equal(result.state.checkpoints["root/escalate"].skipped, true);
});

test("a false plan guard clears any stale plan execution", () => {
  const operators = new Map([["inspect", INSPECT]]);
  const wf = workflow([
    task("frame"),
    { kind: "plan", id: "investigate", operators: ["inspect"], guard: guard("frame", "equals", false, "/data/wide") },
  ], { operators });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { wide: true })) }).state;
  assert.equal(state.status, "completed");
  assert.equal(state.checkpoints["root/investigate"].skipped, true);
  assert.equal(Object.keys(state.plans).length, 0);
});

test("negated value ops fail on missing artifacts rather than skipping", () => {
  const wf = workflow([
    task("frame"),
    task("deep", { guard: guard("frame", "not-equals", "high", "/data/severity") }),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { note: "no severity" })) }).state;
  assert.equal(state.checkpoints["root/deep"].skipped, true);
});


test("skipped checkpoints restore without contract errors", () => {
  const wf = workflow([
    task("frame"),
    task("deep", { output: "finding", guard: guard("frame", "exists", undefined, "/data/missing") }),
    task("deliver"),
  ], { contracts: { finding: { type: "object", required: ["finding"] } } });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { ok: true })) }).state;
  const migrated = validateAgainstWorkflow(wf, state);
  assert.equal(migrated.ok, true);
  assert.equal(state.checkpoints["root/deep"].skipped, true);
});

test("guards reference script checkpoint output", () => {
  const wf = workflow([
    script("probe", { spec: { stdout: "json" } }),
    task("deep", { guard: { from: "probe", select: "/data/pass", op: "gte", value: 1 } }),
    task("deliver"),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, {
    type: "process-exit",
    key: "root/probe",
    exit: { code: 0, timedOut: false, stdout: '{"pass":0}\n', stderr: "", truncated: false },
  }).state;
  assert.equal(state.stack.at(-1).blockId, "deliver", "a failing guard skips the task after a script step");
  assert.equal(state.checkpoints["root/deep"].skipped, true);
});
