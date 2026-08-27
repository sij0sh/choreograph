import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTransitionArguments } from "../../src/pi/tools.ts";

test("moves nested met, status, and issues out of checkpoint to the top level", () => {
  const out = normalizeTransitionArguments({
    checkpoint: { status: "completed", met: ["a", "b"], summary: "done", unknowns: ["risky"] },
  });
  assert.equal(out.status, "completed");
  assert.deepEqual(out.met, ["a", "b"]);
  assert.equal(out.issues, undefined);
  assert.deepEqual(out.checkpoint, { summary: "done", unknowns: ["risky"] });
});

test("unwraps an outcome wrapper object", () => {
  const out = normalizeTransitionArguments({
    outcome: { status: "completed", met: ["a"], checkpoint: { summary: "s" } },
  });
  assert.equal(out.status, "completed");
  assert.deepEqual(out.met, ["a"]);
  assert.deepEqual(out.checkpoint, { summary: "s" });
});

test("relocates stray checkpoint fields into checkpoint.data", () => {
  const out = normalizeTransitionArguments({
    status: "completed",
    checkpoint: { summary: "s", majorWins: ["x"], data: { kept: 1 } },
  });
  assert.deepEqual(out.checkpoint, { summary: "s", data: { kept: 1, majorWins: ["x"] } });
});

test("splits a comma-separated met string and normalizes near-miss ids", () => {
  const out = normalizeTransitionArguments({
    status: "completed",
    met: "Scope_Clear, target-known",
    checkpoint: { summary: "s" },
  });
  assert.deepEqual(out.met, ["scope-clear", "target-known"]);
});

test("a well-formed call passes through unchanged", () => {
  const call = { status: "needs-work", checkpoint: { summary: "s", data: { plan: { version: 1 } } }, issues: [{ target: "root", reason: "broken" }] };
  assert.deepEqual(normalizeTransitionArguments(call), call);
});
