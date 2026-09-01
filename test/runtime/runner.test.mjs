import test from "node:test";
import assert from "node:assert/strict";
import { AgentRunner, ProcessRunner } from "../../src/runtime/runner.ts";
import { processSpecFor } from "../../src/domain/invocation.ts";

const invocation = { blockId: "probe", key: "root/probe", runner: "process", status: "running", attempt: 1 };

const scriptBlock = {
  kind: "script",
  id: "probe",
  script: { argv: ["node", "-e", "process.stdout.write('ok')"], cwd: ".", inheritEnv: ["PATH"], timeoutMs: 10_000, acceptedExitCodes: [0], stdout: "text", stderr: "none", maxCaptureBytes: 65_536 },
};

function dir() { return "/definitely-not-a-real-workflow-dir"; }

function specOf(block, workflowDir) {
  return processSpecFor(block.script, block.id, workflowDir);
}

test("both runners satisfy one shared contract", () => {
  for (const runner of [new AgentRunner(), new ProcessRunner()]) {
    assert.ok(["agent", "process"].includes(runner.kind), "runner declares its kind");
    assert.ok(["at-least-once", "idempotent"].includes(runner.retrySafety), "runner declares retry safety");
    assert.ok(["model", "runtime"].includes(runner.executesOn), "runner declares its execution mode");
    assert.equal(typeof runner.execute, "function");
  }
});

test("ProcessRunner executes through the runner contract and captures raw exit", async () => {
  const runner = new ProcessRunner();
  const result = await runner.execute(invocation, specOf(scriptBlock), {});
  assert.equal(result.status, "succeeded");
  assert.equal(result.exit.stdout, "ok");
  assert.equal(result.exit.code, 0);
  assert.equal(result.reason, undefined);
});

test("ProcessRunner resolves cwd against the workflow directory and contains it", async () => {
  const runner = new ProcessRunner();
  const spec = specOf(scriptBlock, dir());
  assert.equal(spec.cwd, dir(), "processSpecFor resolves the authored relative cwd");
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

test("AgentRunner awaits external completion instead of resolving immediately", async () => {
  const runner = new AgentRunner();
  let settled = false;
  const pending = runner.execute(invocation, { runner: "agent", blockId: "probe", instructionPath: "steps/x.md" }, {}).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, "agent execution stays pending until it is settled");
  assert.equal(runner.settle("root/probe", { status: "succeeded" }), true);
  assert.deepEqual(await pending, { status: "succeeded" });
  assert.equal(runner.settle("root/probe", { status: "succeeded" }), false, "a settled dispatch cannot settle twice");
  const reopened = runner.execute(invocation, { runner: "agent", blockId: "probe", instructionPath: "steps/x.md" }, {});
  runner.cancel(invocation);
  assert.deepEqual(await reopened, { status: "canceled" }, "cancel settles a re-dispatched invocation");
  const bad = await runner.execute(invocation, specOf(scriptBlock), {});
  assert.equal(bad.status, "failed");
  assert.match(bad.reason, /AgentRunner does not run process specs/);
});

test("the stdin budget counts UTF-8 bytes, not characters", async () => {
  const runner = new ProcessRunner();
  const inputs = { note: "é".repeat(13_000) };
  const text = `${JSON.stringify(inputs)}\n`;
  assert.ok(text.length < 24_576, "precondition: the character count stays under the budget");
  assert.ok(Buffer.byteLength(text, "utf8") > 24_576, "precondition: the byte count exceeds the budget");
  const result = await runner.execute(invocation, specOf(scriptBlock), { inputs });
  assert.equal(result.status, "failed", "the oversized byte payload is refused before spawn");
  assert.match(result.reason, /bytes, over the 24576-byte stdin budget/);
});
