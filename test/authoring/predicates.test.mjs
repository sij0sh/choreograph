import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePredicate, parsePredicate, parseValueSource } from "../../src/authoring/predicates.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";
import { start, transition } from "../../src/engine/interpreter.ts";

function stateWith(data) {
  const wf = workflow([task("verify")]);
  const started = start(wf, { runId: "r1" });
  return transition(wf, started.state, { type: "outcome", outcome: completed(cp("done", data)) }).state;
}

test("value sources parse as references or literals", () => {
  assert.deepEqual(parseValueSource("$a.b"), { ref: { root: "a", path: ["b"] } });
  assert.deepEqual(parseValueSource(true), { literal: true });
  assert.deepEqual(parseValueSource("plain"), { literal: "plain" });
  assert.throws(() => parseValueSource(undefined), /reference .* or a JSON literal/);
});

test("predicates parse each operation", () => {
  assert.deepEqual(parsePredicate({ equals: ["$a.passed", true] }), {
    op: "equals",
    left: { ref: { root: "a", path: ["passed"] } },
    right: { literal: true },
  });
  assert.deepEqual(parsePredicate({ exists: "$a.tag" }), { op: "exists", value: { ref: { root: "a", path: ["tag"] } } });
  assert.deepEqual(parsePredicate({ not: { exists: "$a.tag" } }).op, "not");
  assert.equal(parsePredicate({ any: [{ exists: "$a.x" }, { exists: "$a.y" }] }).predicates.length, 2);
  assert.throws(() => parsePredicate({ equals: ["$a"], extra: 1 }), /exactly one/);
  assert.throws(() => parsePredicate({ equals: ["$a"] }), /exactly two values/);
  assert.throws(() => parsePredicate({ all: [] }), /non-empty list/);
});

test("equals and exists evaluate against state", () => {
  const state = stateWith({ passed: true, tag: "x" });
  assert.ok(evaluatePredicate(state, parsePredicate({ equals: ["$verify.passed", true] })));
  assert.ok(!evaluatePredicate(state, parsePredicate({ equals: ["$verify.passed", "true"] })));
  assert.ok(evaluatePredicate(state, parsePredicate({ exists: "$verify.tag" })));
  assert.ok(!evaluatePredicate(state, parsePredicate({ exists: "$verify.missing" })));
  assert.ok(evaluatePredicate(state, parsePredicate({ equals: ["$verify.missing", "$verify.also-missing"] }), ), "undefined equals undefined");
});

test("contains handles arrays and strings", () => {
  const state = stateWith({ files: ["a.ts", "b.ts"], note: "hello world" });
  assert.ok(evaluatePredicate(state, parsePredicate({ contains: ["$verify.files", "a.ts"] })));
  assert.ok(!evaluatePredicate(state, parsePredicate({ contains: ["$verify.files", "c.ts"] })));
  assert.ok(evaluatePredicate(state, parsePredicate({ contains: ["$verify.note", "world"] })));
  assert.ok(!evaluatePredicate(state, parsePredicate({ contains: ["$verify.note", "moon"] })));
});

test("not, all, and any compose", () => {
  const state = stateWith({ passed: true, failed: false });
  assert.ok(evaluatePredicate(state, parsePredicate({ not: { equals: ["$verify.passed", false] } })));
  assert.ok(evaluatePredicate(state, parsePredicate({ all: [{ equals: ["$verify.passed", true] }, { exists: "$verify.failed" }] })));
  assert.ok(evaluatePredicate(state, parsePredicate({ any: [{ equals: ["$verify.passed", false] }, { equals: ["$verify.failed", false] }] })));
  assert.ok(!evaluatePredicate(state, parsePredicate({ all: [{ equals: ["$verify.passed", true] }, { exists: "$verify.missing" }] })));
});
