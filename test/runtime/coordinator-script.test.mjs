import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { completed, cp, script, task, workflow } from "../engine/helpers.mjs";

function harness(options = {}) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    getAllTools: options.allTools ? () => options.allTools.map((name) => ({ name })) : undefined,
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, deliverAs) => {
      sent.push({ message, deliverAs });
    },
  };
  const ctx = {
    ui: {
      status: undefined,
      notices: [],
      setStatus: (id, value) => {
        ctx.ui.status = value;
      },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  return { pi, ctx, sent, entries, activeTools, read };
}

function scriptWorkflow() {
  return workflow([
    script("probe", { spec: { argv: ["node", "-e", "process.stdout.write(JSON.stringify({ answer: 42 }))"], inheritEnv: ["PATH"], stdout: "json" } }),
    task("deliver"),
  ]);
}

test("a script step drives to completion without any model turn", async () => {
  const h = harness();
  const wf = scriptWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "deliver", "the coordinator drove the script and advanced to the task");
  assert.equal(h.sent.length, 1, "exactly one control message, for the task position");
  const checkpoints = run.execution.checkpoints;
  assert.deepEqual(checkpoints["root/probe"].data, { answer: 42 });
  const snapshots = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active");
  assert.ok(snapshots.some((entry) => entry.data.execution.checkpoints["root/probe"]), "the script checkpoint is persisted");
});

test("a script-only workflow completes without sending a model message", async () => {
  const h = harness();
  const wf = workflow([script("only", { spec: { argv: ["node", "-e", "process.stdout.write('done')"], inheritEnv: ["PATH"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.status, "completed");
  assert.equal(h.sent.length, 1, "only the completion summary is sent");
  assert.match(h.sent[0].message, /is complete/, "the single message is the summary request, not a control message");
});

test("workflow_transition is rejected at a script position", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "stuck", "the failed script parks the run");
  assert.ok(h.sent.length >= 1, "the parked run delivers a control message");
  const result = await runtime.transition({ status: "completed", checkpoint: { summary: "trying to move on" } }, undefined, h.ctx);
  assert.ok(result.isError);
  assert.match(result.content[0].text, /does not accept transitions/);
});

test("a parked script notifies the model through a delivered control message", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(h.sent.some((entry) => entry.message.includes("root/stuck")), "the park delivers a control message naming the position");
});

test("exhausted script retries park the run without a model turn in between", async () => {
  const h = harness();
  const wf = workflow([
    script("flaky", { spec: { argv: ["node", "-e", "process.stdout.write('x'.repeat(4))"], inheritEnv: ["PATH"], stdout: "json" }, recovery: { maxAttempts: 2, strategy: ["retry", "block"] } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.status, "active", "the run parks at the script after retries are exhausted");
  assert.equal(run.execution.stack.at(-1).blockId, "flaky");
  assert.match(h.sent.at(-1).message, /root\/flaky/, "the park is announced with one control message, not one per retry");
  assert.equal(h.sent.filter((entry) => !entry.message.includes("is complete")).length, 1);
});

test("restore of an active parked script run resumes and re-parks", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["f"] }),
    script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const done = await runtime.transition({ status: "completed", met: ["f"], checkpoint: { summary: "framed" } }, undefined, h.ctx);
  assert.ok(!done.isError, done.content[0].text);
  assert.equal(h.ctx.ui.status, undefined, "script positions do not render a status",);

  const revivedHarness = harness();
  revivedHarness.entries.push(...h.entries);
  const revived = new RuntimeCoordinator(revivedHarness.pi, [wf], revivedHarness.read);
  revived.handleSessionStart(revivedHarness.ctx);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  assert.ok(
    revivedHarness.ctx.ui.notices.some((notice) => /Resumed/.test(notice.message)),
    "the run resumes",
  );
  const snapshots = revivedHarness.entries.filter((entry) => entry.customType === "choreograph");
  const last = snapshots.at(-1);
  assert.equal(last.data.execution.checkpoints["root/frame"].summary, "framed", "the restored run kept its earlier checkpoints");
});
