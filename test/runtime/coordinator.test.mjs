import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeCoordinator, newRunId } from "../../src/runtime/coordinator.ts";
import { activeSnapshot, terminalSnapshot } from "../../src/persistence/snapshot.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";
import { start } from "../../src/engine/interpreter.ts";

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
    appendEntry: (type, data) => {
      if (options.failAppend) throw options.failAppend;
      entries.push({ type: "custom", customType: type, data });
    },
    sendUserMessage: async (message, deliverAs) => {
      if (options.failSend) throw options.failSend;
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
    models: new Map(),
    model: undefined,
    modelRegistry: { find: (provider, id) => ctx.models.get(`${provider}/${id}`) },
    setModel: undefined,
  };
  const read = () => "# instructions";
  return { pi, ctx, sent, entries, activeTools, read };
}

function coordinator(harness_, workflows) {
  return new RuntimeCoordinator(harness_.pi, workflows, harness_.read);
}

function simpleWorkflow(overrides = {}) {
  return workflow([task("frame", { done: ["framed"] }), task("deliver")], overrides);
}

async function runTo(ctx, coordinator_, workflow, outcomes) {
  await coordinator_.startWorkflow(ctx, workflow, "");
  let last;
  for (const outcome of outcomes) {
    last = await coordinator_.transition(outcome, undefined, ctx);
    await coordinator_.handleAgentSettled(ctx);
  }
  return last;
}

test("starting a run swaps in run tools and persists an active snapshot", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "target");
  assert.ok(run);
  assert.deepEqual([...h.activeTools], ["read", "bash", "workflow_transition", "workflow_abort"]);
  const snapshots = h.entries.filter((entry) => entry.customType === "choreograph");
  assert.equal(snapshots[0].data.delivered, false, "the start snapshot commits before delivery");
  assert.ok(snapshots.some((entry) => entry.data.delivered === true), "the delivered marker follows the send");
  assert.equal(h.sent.length, 1, "the follow-up is sent");
});

test("session start keeps the narrowed active set and offers workflow_start", () => {
  const h = harness({ baseline: ["read", "bash"], allTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"] });
  const wf = simpleWorkflow({ piVisibility: true, tools: ["read", "bash", "edit", "write"] });
  const runtime = coordinator(h, [wf]);
  const warnings = runtime.handleSessionStart(h.ctx);
  assert.deepEqual(warnings.unknownTools, []);
  assert.deepEqual([...h.activeTools], ["read", "bash", "workflow_start"]);
});

test("reload of an active run restores the persisted baseline tools", async () => {
  const h = harness({ baseline: ["read", "bash", "edit", "write"] });
  const wf = simpleWorkflow({ tools: ["read", "bash", "edit", "write"] });
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  assert.deepEqual([...h.activeTools], ["read", "bash", "edit", "write", "workflow_transition", "workflow_abort"]);

  const narrowed = harness({ baseline: ["read", "workflow_transition", "workflow_abort"], allTools: ["read", "bash", "edit", "write"] });
  narrowed.entries.push(...h.entries);
  const restored = coordinator(narrowed, [wf]);
  restored.handleSessionStart(narrowed.ctx);
  assert.deepEqual(
    [...narrowed.activeTools],
    ["read", "bash", "edit", "write", "workflow_transition", "workflow_abort"],
    "the persisted baseline drives the restored run tools",
  );
});

test("resume of a legacy active snapshot without a baseline falls back to registered tools", () => {
  const state = start(simpleWorkflow(), { runId: "legacy" }).state;
  const legacy = activeSnapshot({ workflow: "demo", execution: state, delivered: true });
  const h = harness({ baseline: ["read", "workflow_transition", "workflow_abort"], allTools: ["read", "bash", "edit", "write"] });
  h.entries.push({ type: "custom", customType: "choreograph", data: legacy });
  const runtime = coordinator(h, [simpleWorkflow()]);
  runtime.handleSessionStart(h.ctx);
  assert.deepEqual(
    [...h.activeTools],
    ["read", "bash", "edit", "write", "workflow_transition", "workflow_abort"],
    "registered tools stand in when no baseline was persisted",
  );
});

test("storage failure on start keeps the session idle", async () => {
  const h = harness({ failAppend: new Error("disk full") });
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await assert.rejects(() => runtime.startWorkflow(h.ctx, wf, ""), /disk full/);
  const idle = runtime.handleBeforeAgentStart({ systemPrompt: "base" });
  assert.equal(idle, undefined);
});

test("transitions persist the next snapshot before adopting it", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(runtime.handleBeforeAgentStart({ systemPrompt: "" }).systemPrompt.includes("deliver"), true, "the next position renders");
  const snapshots = h.entries.filter((entry) => entry.customType === "choreograph").map((entry) => entry.data);
  assert.ok(snapshots.some((snapshot) => snapshot.delivered === false), "the pending position snapshot commits first");
  assert.equal(Object.keys(snapshots[0].execution.checkpoints).length + Object.keys(snapshots.at(-1).execution?.checkpoints ?? {}).length >= 1, true);
  const stored = snapshots.find((snapshot) => snapshot.execution && Object.keys(snapshot.execution.checkpoints).length === 1);
  assert.ok(stored, "the frame checkpoint is persisted");
});

test("storage failure on transition keeps the prior position", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  h.entries.push = () => {
    throw new Error("append failed");
  };
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(result.isError);
  assert.match(result.content[0].text, /append failed/);
  assert.match(result.details.status, /storage-failed/);
  const prompt = runtime.handleBeforeAgentStart({ systemPrompt: "" });
  assert.match(prompt.systemPrompt, /frame/, "the run stays at the prior position");
});

test("an undelivered position cannot transition", async () => {
  const h = harness({ failSend: new Error("queue closed") });
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(result.isError);
  assert.match(result.details.status, /delivery-pending/);
});

test("a successful send with a failing marker retries only the marker", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  const originalPush = h.entries.push.bind(h.entries);
  let appended = 0;
  h.entries.push = (...items) => {
    appended += items.length;
    if (appended > 1) throw new Error("marker append failed");
    return originalPush(...items);
  };
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(h.sent.length, 1, "the message was sent exactly once");
  assert.ok(h.ctx.ui.notices.some((notice) => /marker append failed/.test(notice.message)));
  h.entries.push = originalPush;
  await runtime.handleAgentSettled(h.ctx);
  assert.equal(h.sent.length, 1, "the retry commits the marker without resending");
  assert.equal(h.entries.at(-1).data.delivered, true);
});

test("status and field mismatches are rejected without state change", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const blockedWithMet = await runtime.transition(
    { status: "blocked", met: ["framed"], checkpoint: cp("stuck") },
    undefined,
    h.ctx,
  );
  assert.ok(blockedWithMet.isError);
  assert.match(blockedWithMet.content[0].text, /met is only valid with status "completed"/);
  const completedWithIssues = await runtime.transition(
    { status: "completed", met: [], issues: [{ target: "frame", reason: "still broken" }], checkpoint: cp("framed") },
    undefined,
    h.ctx,
  );
  assert.ok(completedWithIssues.isError);
  assert.match(completedWithIssues.content[0].text, /issues is only valid with status "needs-work"/);
  const resumed = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!resumed.isError);
  assert.equal(resumed.details.position, "root/deliver", "the run never moved for the rejected calls");
});

test("a retry re-delivers the retried position", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  assert.equal(h.sent.length, 1);
  const result = await runtime.transition({ status: "needs-work", checkpoint: cp("attempt failed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  assert.match(result.content[0].text, /instructions arrive in the next message/);
  assert.equal(h.sent.length, 2, "the retry sends a new control message");
  assert.ok(h.sent[1].message.includes("root/frame"));
});

test("a send that resolves after abort appends no active snapshot", async () => {
  const send = [];
  const h = harness();
  const originalSend = h.pi.sendUserMessage;
  h.pi.sendUserMessage = async (message, options) => {
    send.push("started");
    await runtime.abort(undefined, h.ctx);
    send.push("finished");
    await originalSend(message, options);
  };
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.deepEqual(send, ["started", "finished"]);
  assert.equal(h.entries.at(-1).data.status, "aborted", "the terminal snapshot is the last entry");
});

test("abort restores idle tools and ignores later transitions", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const result = await runtime.abort(undefined, h.ctx);
  assert.ok(result.terminate);
  assert.ok(![...h.activeTools].includes("workflow_transition"));
  await assert.rejects(() => runtime.transition({ status: "completed", met: [], checkpoint: cp("x") }, undefined, h.ctx), /no active workflow/);
});

test("abort persists the pre-abort execution in the terminal snapshot", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  await runtime.abort(undefined, h.ctx);
  const terminal = h.entries.at(-1).data;
  assert.equal(terminal.status, "aborted");
  assert.equal(terminal.v, 5);
  assert.equal(terminal.execution.status, "aborted");
  assert.equal(terminal.execution.stack.at(-1)?.key, "root/frame");
  assert.equal(Object.keys(terminal.execution.checkpoints).length, 0, "the pre-abort state survives");
});

test("a terminal snapshot reload stays idle", () => {
  const h = harness();
  const wf = simpleWorkflow();
  h.entries.push({ type: "custom", customType: "choreograph", data: terminalSnapshot("completed", wf.name, "r1", { ...start(wf, { runId: "r1" }).state, stack: [], status: "completed" }) });
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  assert.equal(runtime.handleBeforeAgentStart({ systemPrompt: "base" }), undefined, "no run prompt after a terminal snapshot");
  assert.ok(!h.ctx.ui.notices.some((notice) => /Resumed/.test(notice.message)));
});

test("completion persists a terminal snapshot and sends a summary request", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runTo(h.ctx, runtime, wf, [
    { status: "completed", met: ["framed"], checkpoint: cp("framed") },
    { status: "completed", checkpoint: cp("delivered") },
  ]);
  assert.equal(h.entries.at(-1).data.status, "completed");
  assert.ok(h.sent.some((entry) => /is complete\./.test(entry.message)));
});

test("completion persists the post-transition execution in the terminal snapshot", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runTo(h.ctx, runtime, wf, [
    { status: "completed", met: ["framed"], checkpoint: cp("framed") },
    { status: "completed", checkpoint: cp("delivered") },
  ]);
  const terminal = h.entries.at(-1).data;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.v, 5);
  assert.equal(terminal.execution.status, "completed");
  assert.deepEqual(terminal.execution.stack, [], "the post-transition stack is empty");
  assert.deepEqual(Object.keys(terminal.execution.checkpoints).sort(), ["root/deliver", "root/frame"], "every checkpoint survives in the terminal snapshot");
});

test("session resume restores the active run and re-renders its prompt", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "repo");
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);

  const fresh = harness();
  fresh.entries.push(...h.entries);
  const restored = coordinator(fresh, [wf]);
  restored.handleSessionStart(fresh.ctx);
  const prompt = restored.handleBeforeAgentStart({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /deliver/);
  assert.ok(fresh.ctx.ui.notices.some((notice) => /Resumed/.test(notice.message)));
  assert.deepEqual([...fresh.activeTools], ["read", "bash", "workflow_transition", "workflow_abort"]);
});

test("resume drops invalid snapshots with one warning", () => {
  const h = harness();
  const wf = simpleWorkflow();
  const state = start(wf, { runId: "broken" }).state;
  h.entries.push({ type: "custom", customType: "choreograph", data: { ...activeSnapshot({ workflow: wf.name, execution: state, delivered: true }), execution: { ...state, stack: [{ kind: "task", blockId: "ghost", key: "root/ghost", attempt: 1 }] } } });
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  assert.ok(h.ctx.ui.notices.some((notice) => notice.level === "warning" && /Cannot resume|Dropped/.test(notice.message)));
  assert.equal(runtime.handleBeforeAgentStart({ systemPrompt: "base" }), undefined, "no run prompt while idle");
});

test("run ids are unique and timestamped", () => {
  const first = newRunId();
  const second = newRunId();
  assert.notEqual(first, second);
  assert.match(first, /^\d{14}-[0-9a-f]{8}$/);
});
