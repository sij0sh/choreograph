import test from "node:test";
import assert from "node:assert/strict";
import { parseReference, resolveReference } from "../../src/authoring/references.ts";
import { completed, cp, sequence, task, workflow } from "../engine/helpers.mjs";
import { start, transition } from "../../src/engine/interpreter.ts";

test("references parse into root and path", () => {
  assert.deepEqual(parseReference("$discover"), { root: "discover", path: [] });
  assert.deepEqual(parseReference("$discover.data.files"), { root: "discover", path: ["data", "files"] });
  assert.deepEqual(parseReference("$current.file"), { root: "current", path: ["file"] });
});

test("references reject malformed shapes", () => {
  assert.throws(() => parseReference("discover.data"), /must look like/);
  assert.throws(() => parseReference("$Discover"), /must look like/);
  assert.throws(() => parseReference("$a.b.c.d.e.f"), /path segments/);
});

test("references resolve against the latest checkpoint by task id", () => {
  const wf = workflow([task("discover"), task("use")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("found", { files: ["a.ts", "b.ts"] })) }).state;
  assert.deepEqual(resolveReference(state, { root: "discover", path: ["files"] }), ["a.ts", "b.ts"]);
  assert.deepEqual(resolveReference(state, { root: "discover", path: ["files", "1"] }), "b.ts");
  assert.equal(resolveReference(state, { root: "discover", path: ["missing"] }), undefined);
  assert.equal(resolveReference(state, { root: "ghost", path: [] }), undefined);
});

test("the latest checkpoint for a task id wins", () => {
  const loop = sequence("body", [task("discover")]);
  const wf = workflow([
    task("seed"),
    { kind: "foreach", id: "walk", items: { root: "seed", path: ["items"] }, as: "item", body: loop },
    task("discover"),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("seed", { items: [1, 2] })) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("one", { tag: 1 })) }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("two", { tag: 2 })) }).state;
  assert.deepEqual(resolveReference(state, { root: "discover", path: ["tag"] }), 2, "the last loop iteration wins while inside the loop context");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("final", { tag: 3 })) }).state;
  assert.deepEqual(resolveReference(state, { root: "discover", path: ["tag"] }), 3, "a later occurrence replaces the loop's last");
});
