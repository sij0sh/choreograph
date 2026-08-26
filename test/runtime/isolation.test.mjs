import test from "node:test";
import assert from "node:assert/strict";
import { isolateWorkflowContext } from "../../src/runtime/isolation.ts";
import { controlPrefix } from "../../src/runtime/prompts.ts";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";

const RUN = "20250101000000-abcd1234";

function user(text) {
  return { role: "user", content: text };
}

function userParts(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(text) {
  return { role: "toolResult", content: [{ type: "text", text }] };
}

function boundary(key = "a") {
  return user(`Continue workflow \`${RUN}\` at ${key}.`);
}

test("isolation keeps the boundary message and everything after it", () => {
  const messages = [user("original request"), assistant("early work"), toolResult("big output"), boundary("task-b"), user("steering note"), assistant("current work")];
  const isolated = isolateWorkflowContext(messages, RUN);
  assert.deepEqual(isolated, [boundary("task-b"), user("steering note"), assistant("current work")]);
});

test("isolation drops tool output from finished positions", () => {
  const stale = toolResult("10KB of reads from position one");
  const messages = [user("request"), stale, assistant("position one done"), boundary(), assistant("position two")];
  const isolated = isolateWorkflowContext(messages, RUN);
  assert.ok(!isolated.includes(stale), "finished-position tool results are dropped");
  assert.deepEqual(isolated, [boundary(), assistant("position two")]);
});

test("isolation matches array-content user messages", () => {
  const control = userParts(`Continue workflow \`${RUN}\` at plan.`);
  const isolated = isolateWorkflowContext([user("request"), control, assistant("planning")], RUN);
  assert.deepEqual(isolated, [control, assistant("planning")]);
});

test("the latest boundary wins when a run delivers several", () => {
  const first = boundary("task-a");
  const second = boundary("task-b");
  const isolated = isolateWorkflowContext([user("request"), first, assistant("a"), second, assistant("b")], RUN);
  assert.deepEqual(isolated, [second, assistant("b")]);
});

test("a boundary for a different run never matches", () => {
  const other = user("Continue workflow `other-run` at a.");
  const messages = [user("request"), other, assistant("work")];
  assert.equal(isolateWorkflowContext(messages, RUN), undefined);
});

test("no boundary means no filtering", () => {
  const messages = [user("request"), assistant("work"), toolResult("output")];
  assert.equal(isolateWorkflowContext(messages, RUN), undefined);
});

test("a boundary-only context keeps the boundary", () => {
  const isolated = isolateWorkflowContext([boundary()], RUN);
  assert.deepEqual(isolated, [boundary()]);
});

test("control messages from other runs do not leak into the prefix", () => {
  const prefix = controlPrefix(RUN);
  assert.ok(prefix.startsWith("Continue workflow"));
  assert.ok(!prefix.endsWith("at"), "the prefix carries no position; any position matches");
});

function harness() {
  const sent = [];
  const entries = [];
  const activeTools = new Set(["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type, customType: type, data }),
    sendUserMessage: async (message, deliverAs) => sent.push({ message, deliverAs }),
  };
  const ctx = {
    ui: { notices: [], setStatus: () => {}, notify: (message, level) => ctx.ui.notices.push({ message, level }) },
    sessionManager: { getBranch: () => entries },
  };
  return { pi, ctx, sent };
}

test("handleContext filters only for an active, delivered run", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# instructions");
  runtime.handleSessionStart(h.ctx);

  assert.equal(runtime.handleContext({ messages: [user("chat")] }), undefined, "idle: no filtering");

  await runtime.startWorkflow(h.ctx, wf, "target");
  const runId = h.sent[0].message.match(/`([^`]+)`/)[1];
  const boundaryMsg = user(`Continue workflow \`${runId}\` at frame.`);
  const isolated = runtime.handleContext({ messages: [user("target"), boundaryMsg, assistant("work")] });
  assert.ok(isolated, "active and delivered: filtering applies");
  assert.equal(isolated.messages.length, 2);

  const finished = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!finished.isError);
  const nextBoundary = user(`Continue workflow \`${runId}\` at deliver.`);
  const after = runtime.handleContext({ messages: [boundaryMsg, assistant("work"), nextBoundary] });
  assert.ok(after, "the next delivered position filters again");
  assert.equal(after.messages.length, 1, "only the new boundary survives");
});

test("handleContext keeps everything before delivery", async () => {
  const h = harness();
  const wf = workflow([task("frame")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# instructions");
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "target");
  h.sent.length = 0;

  await runtime.transition({ status: "completed", checkpoint: cp("done") }, undefined, h.ctx);
  assert.equal(runtime.handleContext({ messages: [user("anything")] }), undefined, "not yet delivered: safe fallback");
});
