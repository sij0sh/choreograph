import test from "node:test";
import assert from "node:assert/strict";
import { RunnerRegistry } from "../../src/runtime/registry.ts";
import { AgentRunner, ProcessRunner } from "../../src/runtime/runner.ts";
import { processSpecFor } from "../../src/domain/invocation.ts";

function registry() {
  return new RunnerRegistry([new AgentRunner(), new ProcessRunner()]);
}

function invocation(key, runner, attempt = 1) {
  return { blockId: key.split("/").pop() ?? key, key, runner, status: "running", attempt };
}

function specOf(block) {
  return processSpecFor(block.script, block.id);
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
  const first = reg.dispatch(invocation("root/probe", "process"), specOf(okScript));
  const result = await first.result;
  assert.equal(result.status, "succeeded");
  assert.equal(result.exit.stdout, "ok");
  assert.notEqual(reg.dispatch(invocation("root/probe", "process"), specOf(okScript)), first, "a resolved dispatch leaves the registry, so a repeat dispatch starts fresh");
});

test("agent dispatch awaits external completion through the registry", async () => {
  const reg = registry();
  const handle = reg.dispatch(invocation("root/frame", "agent"), agentSpec);
  let settled = false;
  const pending = handle.result.then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, "the dispatch stays pending until completion");
  assert.equal(reg.dispatch(invocation("root/frame", "agent"), agentSpec), handle, "the pending dispatch is deduplicated by invocation key");
  assert.equal(reg.complete("root/frame", { status: "succeeded" }), true);
  assert.deepEqual(await pending, { status: "succeeded" });
  assert.equal(reg.complete("root/frame", { status: "succeeded" }), false, "a settled dispatch cannot complete twice");
  assert.notEqual(reg.dispatch(invocation("root/frame", "agent"), agentSpec), handle, "completion clears the dispatch");
});;

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
  assert.equal(await reg.cancel("root/frame"), false, "cancel is a no-op once nothing is active");
});

test("cancel aborts an in-flight process dispatch", async () => {
  const reg = registry();
  const pending = reg.dispatch(invocation("root/slow", "process"), specOf(slowScript)).result;
  assert.equal(await reg.cancel("root/slow"), true, "cancel reports true only while the dispatch is active");
  assert.equal((await pending).status, "canceled");
});

test("re-dispatching an at-least-once runner requires an explicit retry acknowledgment", async () => {
  const reg = registry();
  const refused = await reg.dispatch(invocation("root/probe", "process", 2), specOf(okScript)).result;
  assert.equal(refused.status, "failed", "attempt 2 on an at-least-once runner is refused without the acknowledgment");
  assert.match(refused.reason, /at-least-once/);
  assert.match(refused.reason, /retry acknowledgment/);
  const acknowledged = await reg.dispatch(invocation("root/probe", "process", 2), specOf(okScript), undefined, { acknowledgedRetry: true }).result;
  assert.equal(acknowledged.status, "succeeded", "a deliberate re-dispatch acknowledges the retry safety");
  const handle = reg.dispatch(invocation("root/frame", "agent", 2), agentSpec);
  assert.equal(reg.complete("root/frame", { status: "succeeded" }), true, "idempotent runners re-dispatch without an acknowledgment");
  assert.deepEqual(await handle.result, { status: "succeeded" });
});
