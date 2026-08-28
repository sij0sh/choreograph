import test from "node:test";
import assert from "node:assert/strict";
import { AgentRunner, ProcessRunner } from "../../src/runtime/runner.ts";
import { processSpecOf } from "../../src/domain/node.ts";

const invocation = { blockId: "probe", key: "root/probe", runner: "process", status: "running", attempt: 1 };

const scriptBlock = {
  kind: "script",
  id: "probe",
  script: { argv: ["node", "-e", "process.stdout.write('ok')"], cwd: ".", inheritEnv: ["PATH"], timeoutMs: 10_000, acceptedExitCodes: [0], stdout: "text", stderr: "none", maxCaptureBytes: 65_536 },
};

function dir() { return "/definitely-not-a-real-workflow-dir"; }

test("both runners satisfy one shared contract", () => {
  for (const runner of [new AgentRunner(), new ProcessRunner()]) {
    assert.ok(["agent", "process"].includes(runner.kind), "runner declares its kind");
    assert.ok(["at-least-once", "idempotent"].includes(runner.retrySafety), "runner declares retry safety");
    assert.equal(typeof runner.execute, "function");
  }
});

test("ProcessRunner executes through the runner contract and captures raw exit", async () => {
  const runner = new ProcessRunner();
  const result = await runner.execute(invocation, processSpecOf(scriptBlock), {});
  assert.equal(result.status, "succeeded");
  assert.equal(result.exit.stdout, "ok");
  assert.equal(result.exit.code, 0);
  assert.equal(result.reason, undefined);
});

test("ProcessRunner resolves cwd against the workflow directory and contains it", async () => {
  const runner = new ProcessRunner();
  const spec = processSpecOf(scriptBlock, dir());
  assert.equal(spec.cwd, dir(), "processSpecOf resolves the authored relative cwd");
  assert.equal(spec.containmentRoot, dir());
  const result = await runner.execute(invocation, spec, {});
  assert.equal(result.status, "failed", "the fake workflow directory does not exist, so spawn fails");
  assert.match(result.reason, /ENOENT|could not be resolved|spawn failed/);
});

test("ProcessRunner rejects a spec for another runner", async () => {
  const runner = new ProcessRunner();
  const result = await runner.execute(invocation, { runner: "agent", blockId: "probe", instructionPath: "steps/x.md" }, {});
  assert.equal(result.status, "failed");
  assert.match(result.reason, /ProcessRunner does not run agent specs/);
});

test("AgentRunner accepts agent specs and rejects process specs", async () => {
  const runner = new AgentRunner();
  const ok = await runner.execute(invocation, { runner: "agent", blockId: "probe", instructionPath: "steps/x.md" }, {});
  assert.deepEqual(ok, { status: "succeeded" });
  const bad = await runner.execute(invocation, processSpecOf(scriptBlock), {});
  assert.equal(bad.status, "failed");
  assert.match(bad.reason, /AgentRunner does not run process specs/);
});
