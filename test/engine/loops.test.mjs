import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, sequence, task, workflow } from "./helpers.mjs";

function foreachBlock(id, items, body, as = "item") {
  return { kind: "foreach", id, items, as, body };
}

function repeatBlock(id, max, body, until) {
  return { kind: "repeat", id, max, body, ...(until ? { until } : {}) };
}

function chooseBlock(id, value, cases, fallback) {
  return { kind: "choose", id, value, cases, ...(fallback ? { fallback } : {}) };
}

const FILES = { root: "discover", path: ["files"] };

function runUntilDone(wf, state, visits) {
  let current = state;
  while (current.status === "active") {
    const leaf = current.stack.at(-1);
    visits.push(leaf.key);
    const next = transition(wf, current, { type: "outcome", outcome: completed(cp(`${leaf.key} done`)) });
    assert.ok(next.ok, `transition at ${leaf.key} failed: ${next.ok ? "" : next.error}`);
    current = next.state;
  }
  return current;
}

test("for_each runs its body once per item with per-iteration keys", () => {
  const body = sequence("body", [task("inspect")]);
  const wf = workflow([task("discover"), foreachBlock("review", FILES, body)]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["a.ts", "b.ts", "c.ts"] })) }).state;
  const visits = [];
  runUntilDone(wf, state, visits);
  assert.deepEqual(visits, ["root/review[0]/body/inspect", "root/review[1]/body/inspect", "root/review[2]/body/inspect"]);
});

test("for_each snapshots its items on entry", () => {
  const body = sequence("body", [task("inspect")]);
  const wf = workflow([task("discover"), foreachBlock("review", FILES, body)]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["a", "b"] })) }).state;
  const frame = state.stack.find((f) => f.kind === "foreach");
  assert.deepEqual(frame.items, ["a", "b"], "resolved items persist in the frame");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("one")) }).state;
  const after = state.stack.find((f) => f.kind === "foreach");
  assert.deepEqual(after.items, ["a", "b"]);
  assert.equal(after.index, 1, "the frame index advances without re-resolving");
});

test("for_each skips when the reference does not resolve", () => {
  const body = sequence("body", [task("inspect")]);
  const wf = workflow([task("warmup"), foreachBlock("review", FILES, body), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("no data")) }).state;
  assert.equal(state.stack.at(-1).blockId, "deliver", "the loop body never runs");
});

test("for_each rejects non-list items", () => {
  const body = sequence("body", [task("inspect")]);
  const wf = workflow([task("discover"), foreachBlock("review", FILES, body)]);
  let state = start(wf, { runId: "r1" }).state;
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("bad", { files: "a.ts" })) });
  assert.ok(!result.ok);
  assert.match(result.error, /non-list/);
});

test("for_each enforces its item bound", () => {
  const body = sequence("body", [task("inspect")]);
  const wf = workflow([task("discover"), foreachBlock("review", FILES, body)]);
  let state = start(wf, { runId: "r1" }).state;
  const files = Array.from({ length: 65 }, (_, i) => `f${i}`);
  const result = transition(wf, state, { type: "outcome", outcome: completed(cp("too many", { files })) });
  assert.ok(!result.ok);
  assert.match(result.error, /bound is 64/);
});

test("$current resolves to the innermost iteration", () => {
  const body = sequence("body", [task("inspect")]);
  const outerBody = sequence("outer-body", [foreachBlock("inner", { root: "current", path: [] }, body, "inner-item")]);
  const wf = workflow([task("discover"), foreachBlock("outer", FILES, outerBody, "outer-item")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: [["x", "y"], ["z"]] })) }).state;
  const inner = state.stack.find((f) => f.kind === "foreach" && f.blockId === "inner");
  assert.deepEqual(inner.items, ["x", "y"], "the inner loop iterates the current outer item");
  assert.deepEqual(state.stack.map((f) => `${f.kind}:${f.blockId}`), [
    "sequence:root",
    "foreach:outer",
    "sequence:outer-body",
    "foreach:inner",
    "sequence:body",
    "task:inspect",
  ], "nested loops preserve both frames");
});

test("repeat stops when until becomes true", () => {
  const body = sequence("body", [task("improve"), task("verify")]);
  const until = { op: "equals", left: { ref: { root: "verify", path: ["passed"] } }, right: { literal: true } };
  const wf = workflow([repeatBlock("refine", 5, body, until), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  const visits = [];
  let current = state;
  let round = 0;
  while (current.stack.at(-1)?.blockId !== "deliver") {
    const leaf = current.stack.at(-1);
    visits.push(leaf.key);
    const data = leaf.blockId === "verify" && ++round === 2 ? { passed: true } : undefined;
    const next = transition(wf, current, { type: "outcome", outcome: completed(cp("step", data)) });
    assert.ok(next.ok);
    current = next.state;
  }
  assert.deepEqual(
    visits.filter((key) => key.endsWith("/verify")),
    ["root/refine#0/body/verify", "root/refine#1/body/verify"],
    "the second verify pass satisfies until",
  );
});

test("repeat respects its max bound without until", () => {
  const body = sequence("body", [task("improve")]);
  const wf = workflow([repeatBlock("refine", 3, body), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  const visits = [];
  const final = runUntilDone(wf, state, visits);
  assert.equal(final.status, "completed");
  assert.deepEqual(visits, [
    "root/refine#0/body/improve",
    "root/refine#1/body/improve",
    "root/refine#2/body/improve",
    "root/deliver",
  ]);
});

test("choose selects the matching case", () => {
  const cases = {
    fast: sequence("fast-body", [task("quick")]),
    slow: sequence("slow-body", [task("thorough")]),
  };
  const wf = workflow([task("discover"), chooseBlock("route", { root: "discover", path: ["mode"] }, cases)]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { mode: "slow" })) }).state;
  assert.equal(state.stack.at(-1).blockId, "thorough");
  assert.equal(state.stack.find((f) => f.kind === "choose").caseName, "slow");
});

test("choose falls back and skips without a match", () => {
  const cases = { fast: sequence("fast-body", [task("quick")]) };
  const fallback = sequence("fallback-body", [task("thorough")]);
  const wf = workflow([task("discover"), chooseBlock("route", { root: "discover", path: ["mode"] }, cases, fallback), task("deliver")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { mode: "unknown" })) }).state;
  assert.equal(state.stack.at(-1).blockId, "thorough");

  const noFallbackWf = workflow([task("discover"), chooseBlock("route", { root: "discover", path: ["mode"] }, cases), task("deliver")]);
  let state2 = start(noFallbackWf, { runId: "r2" }).state;
  state2 = transition(noFallbackWf, state2, { type: "outcome", outcome: completed(cp("found", { mode: "unknown" })) }).state;
  assert.equal(state2.stack.at(-1).blockId, "deliver", "an unmatched choose with no fallback skips the block");
});

test("a mid-loop restart reproduces the same remaining iterations", () => {
  const build = () => {
    const body = sequence("body", [task("inspect")]);
    return workflow([task("discover"), foreachBlock("review", FILES, body), task("deliver")]);
  };
  const wf = build();
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["a", "b", "c"] })) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("one")) }).state;

  const interrupted = runUntilDone(build(), structuredClone(state), []);
  const resumed = JSON.parse(JSON.stringify(state));
  const continued = runUntilDone(build(), resumed, []);
  assert.equal(interrupted.status, "completed");
  assert.deepEqual(interrupted.checkpoints, continued.checkpoints);
  assert.deepEqual(
    Object.keys(continued.checkpoints),
    ["root/discover", "root/review[0]/body/inspect", "root/review[1]/body/inspect", "root/review[2]/body/inspect", "root/deliver"],
  );
});
