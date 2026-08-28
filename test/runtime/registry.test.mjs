import test from "node:test";
import assert from "node:assert/strict";
import { RunnerRegistry } from "../../src/runtime/registry.ts";
import { AgentRunner, ProcessRunner } from "../../src/runtime/runner.ts";
import { processSpecOf } from "../../src/domain/node.ts";

function registry() {
  return new RunnerRegistry([new AgentRunner(), new ProcessRunner()]);
}

function invocation(key, runner, attempt = 1) {
  return { blockId: key.split("/").pop() ?? key, key, runner, status: "running", attempt };
}

const okScript = {
  kind: "script",
  id: "probe",
  script: { argv: ["node", "-e", "process.stdout.write('ok')"], cwd: ".", inheritEnv: ["PATH"], timeoutMs: 10_000, acceptedExitCodes: [0], stdout: "text", stderr: "none", maxCaptureBytes: 65_536 },
};

const slowScript = {
  kind: "script",
  id: "slow",
  script: { argv: ["node", "-e", "setTimeout(() => {}, 10_000)"], cwd: ".", inheritEnv: ["PATH"], timeoutMs: 20_000, acceptedExitCodes: [0], stdout: "text", stderr: "none", maxCaptureBytes: 65_536 },
};

const agentSpec = { runner: "agent", blockId: "frame" };

test("the registry routes by runner kind and refuses unknown kinds", () => {
  const reg = registry();
  assert.equal(reg.runnerFor("agent").kind, "agent");
  assert.equal(reg.runnerFor("process").kind, "process");
  assert.throws(() => reg.runnerFor("planner"), /no runner registered for "planner"/);
});

test("process dispatch runs the spec through the registry and clears when done", async () => {
  const reg = registry();
  const result = await reg.dispatch(invocation("root/probe", "process"), processSpecOf(okScript)).result;
  assert.equal(result.status, "succeeded");
  assert.equal(result.exit.stdout, "ok");
  assert.equal(reg.activeInvocations().length, 0, "a resolved dispatch leaves the registry");
});

test("agent dispatch awaits external completion through the registry", async () => {
  const reg = registry();
  let settled = false;
  const pending = reg.dispatch(invocation("root/frame", "agent"), agentSpec).result.then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, "the dispatch stays pending until completion");
  assert.deepEqual(reg.activeInvocations().map((entry) => entry.key), ["root/frame"]);
  assert.equal(reg.complete("root/frame", { status: "succeeded" }), true);
  assert.deepEqual(await pending, { status: "succeeded" });
  assert.equal(reg.activeInvocations().length, 0, "completion clears the dispatch");
  assert.equal(reg.complete("root/frame", { status: "succeeded" }), false, "a settled dispatch cannot complete twice");
});

test("dispatch is idempotent per invocation key while it is pending", () => {
  const reg = registry();
  const first = reg.dispatch(invocation("root/frame", "agent"), agentSpec);
  assert.equal(reg.dispatch(invocation("root/frame", "agent"), agentSpec), first);
  assert.equal(reg.complete("root/frame", { status: "failed", reason: "needs-work" }), true);
  const reopened = reg.dispatch(invocation("root/frame", "agent"), agentSpec);
  assert.notEqual(reopened, first, "a fresh dispatch follows completion");
  assert.equal(reg.complete("root/frame", { status: "succeeded" }), true);
});

test("cancel settles an awaiting agent dispatch as canceled", async () => {
  const reg = registry();
  const pending = reg.dispatch(invocation("root/frame", "agent"), agentSpec).result;
  assert.equal(await reg.cancel("root/frame"), true);
  assert.deepEqual(await pending, { status: "canceled" });
  assert.equal(reg.activeInvocations().length, 0);
  assert.equal(await reg.cancel("root/frame"), false, "cancel is a no-op once nothing is active");
});

test("cancel aborts an in-flight process dispatch", async () => {
  const reg = registry();
  const pending = reg.dispatch(invocation("root/slow", "process"), processSpecOf(slowScript)).result;
  assert.deepEqual(reg.activeInvocations().map((entry) => entry.key), ["root/slow"]);
  assert.equal(await reg.cancel("root/slow"), true);
  assert.equal((await pending).status, "canceled");
});
