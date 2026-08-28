import test from "node:test";
import assert from "node:assert/strict";
import { RunJournal, parseEvent, project, fold, summarizeProjection, describeEvent } from "../../src/runtime/journal.ts";
import { renderStatus, renderEventLog, nextTuiMode, tuiModeFromEnv } from "../../src/runtime/tui.ts";
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

function simpleWorkflow() {
  return workflow([task("frame", { done: ["framed"] }), task("deliver")]);
}

test("parseEvent accepts well-formed events and drops malformed ones", () => {
  const good = parseEvent({ type: "node-started", runId: "r1", at: 1, key: "root/a", runner: "agent", attempt: 1 });
  assert.equal(good.type, "node-started");
  assert.equal(parseEvent({ type: "from-the-future", runId: "r1", at: 1 }), undefined, "unknown types are dropped");
  assert.equal(parseEvent({ type: "node-started", runId: "r1", at: 1, key: "k", runner: "quantum", attempt: 1 }), undefined);
  assert.equal(parseEvent({ type: "run-completed", at: 1 }), undefined, "missing runId is dropped");
  assert.equal(parseEvent(null), undefined);
});

test("the journal stays bounded and folds into a projection", () => {
  const journal = new RunJournal();
  for (let i = 0; i < 600; i += 1) {
    journal.append({ type: "node-succeeded", runId: "r1", at: i, key: `root/n${i}` });
  }
  assert.equal(journal.size, 512, "the journal is bounded at 512 events");
  assert.equal(journal.all[0].key, "root/n88", "the oldest events are dropped");
  const events = [
    { type: "run-started", runId: "r", at: 0, workflow: "demo", target: "" },
    { type: "node-started", runId: "r", at: 1, key: "root/a", runner: "agent", attempt: 1 },
    { type: "node-failed", runId: "r", at: 2, key: "root/a", reason: "boom" },
    { type: "retry-scheduled", runId: "r", at: 3, key: "root/a", attempt: 2 },
    { type: "node-started", runId: "r", at: 4, key: "root/a", runner: "agent", attempt: 2 },
    { type: "node-succeeded", runId: "r", at: 5, key: "root/a" },
    { type: "run-completed", runId: "r", at: 6 },
  ];
  const view = project(events);
  assert.equal(view.status, "succeeded");
  assert.equal(view.invocations["root/a"].attempts, 2);
  assert.equal(view.invocations["root/a"].status, "succeeded");
  assert.equal(view.invocations["root/a"].lastReason, "boom");
  assert.equal(fold(undefined, events[1]), undefined, "node events without a run fold to nothing");
});

test("projection rebuilds from persisted events alone", () => {
  const events = [
    { type: "run-started", runId: "r", at: 0, workflow: "demo", target: "t" },
    { type: "node-started", runId: "r", at: 1, key: "root/a", runner: "process", attempt: 1 },
    { type: "node-failed", runId: "r", at: 2, key: "root/a", reason: "exit 1" },
    { type: "run-paused", runId: "r", at: 3, reason: "parked" },
  ];
  const replayed = events.map((event) => parseEvent(event));
  const view = project(replayed);
  assert.equal(view.status, "waiting");
  assert.equal(view.invocations["root/a"].status, "failed");
  assert.match(summarizeProjection(view), /status=waiting nodes=1/);
});

test("a node failure fails the projection until a retry or park follows", () => {
  const started = { type: "run-started", runId: "r", at: 0, workflow: "demo", target: "" };
  const begin = { type: "node-started", runId: "r", at: 1, key: "root/a", runner: "process", attempt: 1 };
  const failed = { type: "node-failed", runId: "r", at: 2, key: "root/a", reason: "runner crashed" };
  const failedView = project([started, begin, failed].map((event) => parseEvent(event)));
  assert.equal(failedView.status, "failed", "a node failure fails the run projection");
  assert.equal(failedView.invocations["root/a"].status, "failed");

  const retryView = project(
    [started, begin, failed, { type: "retry-scheduled", runId: "r", at: 3, key: "root/a", attempt: 2 }].map((event) => parseEvent(event)),
  );
  assert.equal(retryView.status, "running", "a scheduled retry returns the projection to running");

  const parkedView = project(
    [started, begin, { type: "node-waiting", runId: "r", at: 3, key: "root/a", reason: "retries exhausted" }].map((event) => parseEvent(event)),
  );
  assert.equal(parkedView.status, "waiting", "a parked node keeps the projection waiting");
});

test("a run appends lifecycle events for start, agent nodes, and completion", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "ship it");
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", checkpoint: cp("delivered") }, undefined, h.ctx);
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("run-started"), "the start is journaled");
  assert.ok(types.includes("node-started"), "agent node starts are journaled");
  assert.ok(types.filter((type) => type === "node-succeeded").length >= 2, "each completed node is journaled");
  assert.equal(types.at(-1), "run-completed", "the completion is journaled");
  const started = events.find((event) => event.type === "run-started");
  assert.equal(started.target, "ship it");
});

test("script runs journal started and succeeded events, then advance", async () => {
  const h = harness();
  const wf = workflow([
    script("probe", { spec: { argv: ["node", "-e", "process.stdout.write(JSON.stringify({ answer: 42 }))"], inheritEnv: ["PATH"], stdout: "json" } }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("node-started"), "the script start is journaled");
  assert.ok(types.includes("node-succeeded"), "the script success is journaled");
  assert.equal(types.at(-1), "node-started", "the run then waits at the next task");
});

test("a script-only run journals started through completed", async () => {
  const h = harness();
  const wf = workflow([script("only", { spec: { argv: ["node", "-e", "process.stdout.write('done')"], inheritEnv: ["PATH"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const types = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data.type);
  assert.deepEqual(types, ["run-started", "node-started", "node-succeeded", "run-completed"]);
});

test("restore replays persisted events into the projection", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);

  const restored = harness();
  restored.entries.push(...h.entries);
  const runtime2 = new RuntimeCoordinator(restored.pi, [wf], restored.read);
  runtime2.handleSessionStart(restored.ctx);
  const report = runtime2.inspect();
  assert.ok(report, "an active restored run can be inspected");
  assert.ok(report.projection, "the projection rebuilds from replayed events");
  assert.equal(report.projection.workflow, "demo");
  assert.ok(report.projection.invocations["root/frame"], "the first node appears in the replayed projection");
  assert.ok(report.events.some((line) => /root\/frame started/.test(line)), "replayed events are listed");
});

test("TUI renders off, compact, and detailed modes from the projection", () => {
  const events = [
    { type: "run-started", runId: "r", at: 0, workflow: "demo", target: "" },
    { type: "node-started", runId: "r", at: 1, key: "root/a", runner: "agent", attempt: 1 },
  ];
  const projection = project(events.map((event) => parseEvent(event)));
  assert.equal(renderStatus({ mode: "off" }), undefined, "off clears the status line");
  assert.equal(renderStatus({ mode: "compact" }), "workflow: idle", "compact falls back without a projection");
  assert.match(renderStatus({ mode: "compact", compact: "demo: root/a", projection }), /demo: root\/a · status=running/);
  const detailed = renderStatus({ mode: "detailed", compact: "demo: root/a", projection });
  assert.ok(detailed.includes("recent: "), "detailed names the most recent event");
  assert.match(detailed, /nodes=1/);
  assert.deepEqual(renderEventLog(events, 2).length, 2);
});

test("workflow-tui cycles modes and the env var picks the initial mode", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [simpleWorkflow()], h.read);
  const seen = [];
  seen.push(await runCycle(runtime, h));
  seen.push(await runCycle(runtime, h));
  seen.push(await runCycle(runtime, h));
  assert.deepEqual(seen, ["detailed", "off", "compact"], "cycling wraps through all three modes");
  assert.equal(tuiModeFromEnv("detailed"), "detailed");
  assert.equal(tuiModeFromEnv("nonsense"), "compact");
  assert.equal(tuiModeFromEnv(undefined, "off"), "off");
  assert.equal(nextTuiMode("off"), "compact");
});

async function runCycle(runtime, h) {
  const mode = runtime.cycleTuiMode(h.ctx);
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  return mode;
}

test("descriptions are stable strings", () => {
  const event = parseEvent({ type: "node-failed", runId: "r", at: 1_700_000_000_000, key: "root/a", reason: "exit 3" });
  assert.match(describeEvent(event), /root\/a failed: exit 3/);
});

test("agent lifecycle events come from recorded invocations, not delivery", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition({ status: "needs-work", checkpoint: cp("stuck") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const starts = events.filter((event) => event.type === "node-started");
  assert.equal(starts.length, 3, "exactly one start per attempt and per position");
  assert.deepEqual(
    starts.map((event) => [event.key, event.attempt]),
    [["root/frame", 1], ["root/frame", 2], ["root/deliver", 1]],
  );
  assert.ok(events.some((event) => event.type === "retry-scheduled" && event.key === "root/frame" && event.attempt === 2));
  assert.ok(events.some((event) => event.type === "node-succeeded" && event.key === "root/frame"));
});
