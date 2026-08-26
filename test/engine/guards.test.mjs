import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { validateAgainstWorkflow } from "../../src/persistence/migrate.ts";
import { completed, cp, needsWork, task, workflow } from "./helpers.mjs";

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

test("invalidating the producer rewinds and re-evaluates the guard", () => {
  const wf = workflow([
    task("frame", { recovery: { maxAttempts: 2, maxReplans: 2, strategy: ["retry", "block"] } }),
    task("deep", { guard: guard("frame", "equals", "high", "/data/severity") }),
    task("deliver", { inputs: { verdict: { from: "deep" } }, recovery: { maxAttempts: 1, maxReplans: 2, strategy: ["invalidate", "block"] } }),
  ], { inputEdges: { deep: ["frame"], deliver: ["deep"] } });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { severity: "low" })) }).state;
  assert.equal(state.checkpoints["root/deep"].skipped, true);
  const result = transition(wf, state, {
    type: "outcome",
    outcome: needsWork(cp("wrong"), [{ target: "frame", reason: "severity was misjudged" }]),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  // frame invalidates and reruns; its guard consumer rewinds with it
  assert.equal(result.state.stack.at(-1).blockId, "frame");
  assert.equal(result.state.checkpoints["root/deep"], undefined);
  // rerun frame with severity high; the guard now holds and deep runs
  const rerun = transition(wf, result.state, { type: "outcome", outcome: completed(cp("reframed", { severity: "high" })) });
  assert.ok(rerun.ok, rerun.ok ? "" : rerun.error);
  assert.equal(rerun.state.stack.at(-1).blockId, "deep");
  assert.equal(rerun.state.checkpoints["root/deep"], undefined);
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
