import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileWorkflow } from "../../src/authoring/compile.ts";
import { task, workflow } from "../engine/helpers.mjs";

test("compileWorkflow produces a stable digest independent of the workflow location", () => {
  const wf = (root) => workflow([
    task("frame", { instructionPath: `${root}/steps/frame.md` }),
    task("deliver", { instructionPath: `${root}/steps/deliver.md` }),
  ]);
  const first = compileWorkflow(wf("/tmp/one"), () => "same content", "/tmp/one");
  const second = compileWorkflow(wf("/tmp/other"), () => "same content", "/tmp/other");
  assert.equal(first.digest, second.digest, "only workflow-relative paths and content shape the digest");
  assert.match(first.digest, /^[0-9a-f]{64}$/);
});

test("compileWorkflow changes the digest when the workflow structure changes", () => {
  const content = "same content";
  const first = compileWorkflow(workflow([task("frame"), task("deliver")]), () => content, "/tmp/one");
  const second = compileWorkflow(workflow([task("frame"), task("deliver", { done: ["d"] })]), () => content, "/tmp/one");
  assert.notEqual(first.digest, second.digest, "block shape changes invalidate the digest");
});

test("compileWorkflow changes the digest when an instruction file changes", () => {
  const wf = workflow([task("frame")]);
  let content = "v1";
  const first = compileWorkflow(wf, () => content, "/tmp/x");
  content = "v2";
  const second = compileWorkflow(wf, () => content, "/tmp/x");
  assert.notEqual(first.digest, second.digest);
  const digest = createHash("sha256").update("v2").digest("hex");
  assert.equal(second.instructionDigests.get("frame"), digest);
});

test("compileWorkflow skips unreadable instruction files but still compiles", () => {
  const wf = workflow([task("frame"), task("deliver")]);
  const compiled = compileWorkflow(wf, (path) => (path.endsWith("deliver.md") ? "ok" : undefined), "/tmp/x");
  assert.ok(compiled.digest);
  assert.equal(compiled.instructionDigests.size, 1);
  assert.match(compiled.instructionDigests.get("deliver"), /^[0-9a-f]{64}$/, "readable files carry a content digest");
  assert.equal(compiled.instructionDigests.get("frame"), undefined, "missing files carry no digest");
  assert.equal(compiled.nodes.size, 2, "both agent steps appear as node specs");
});

test("compiled nodes distinguish agent and process runners", () => {
  const wf = workflow([task("frame"), { kind: "script", id: "probe", script: { argv: ["node", "-e", "1"], cwd: ".", timeoutMs: 1000, acceptedExitCodes: [0], stdout: "text", stderr: "none", maxCaptureBytes: 1024 } }]);
  const compiled = compileWorkflow(wf, () => "content", "/tmp/x");
  assert.equal(compiled.nodes.get("frame").runner, "agent");
  assert.equal(compiled.nodes.get("probe").runner, "process");
  assert.equal(compiled.nodes.get("probe").cwd, "/tmp/x", "process specs resolve cwd against the workflow directory");
});
