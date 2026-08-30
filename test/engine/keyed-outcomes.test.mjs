import test from "node:test";
import assert from "node:assert/strict";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { completed, cp, needsWork, task, workflow } from "../engine/helpers.mjs";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);

const run = (children) => {
  const wf = workflow(children);
  return { wf, started: start(wf, { runId: "r1" }) };
};

test("an outcome keyed to another position is rejected and changes nothing (corr-c1)", () => {
  const { wf, started } = run([task("frame", { done: ["framed"] }), task("deliver")]);
  const rejected = transition(wf, started.state, { type: "outcome", outcome: { ...completed(cp("framed"), ["framed"]), key: "root/other" } });
  assert.ok(!rejected.ok);
  assert.match(rejected.error, /outcome key root\/other does not match position root\/frame/);
  const retry = transition(wf, started.state, { type: "outcome", outcome: completed(cp("framed"), ["framed"]) });
  assert.ok(retry.ok, "the run still accepts the correctly keyed outcome after a rejection");
  assert.equal(retry.state.stack.at(-1).blockId, "deliver", "the correct key applies to the frame position only");
});

test("a replayed completed outcome for a finished position is rejected (corr-c1)", () => {
  const { wf, started } = run([task("frame", { done: ["framed"] }), task("deliver")]);
  const first = transition(wf, started.state, { type: "outcome", outcome: completed(cp("framed"), ["framed"]) });
  assert.ok(first.ok);
  const replay = transition(wf, first.state, { type: "outcome", outcome: { ...completed(cp("framed"), ["framed"]), key: "root/frame" } });
  assert.ok(!replay.ok);
  assert.match(replay.error, /outcome key root\/frame does not match position root\/deliver/);
});

test("needs-work outcomes are keyed too (corr-c1)", () => {
  const { wf, started } = run([task("frame")]);
  const rejected = transition(wf, started.state, { type: "outcome", outcome: { ...needsWork(cp("stuck")), key: "root/elsewhere" } });
  assert.ok(!rejected.ok);
  assert.match(rejected.error, /does not match position root\/frame/);
});
