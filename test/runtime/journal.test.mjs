import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal, parseEvent, project, fold, summarizeProjection, describeEvent } from "../../src/runtime/journal.ts";
import { renderStatus, renderDetailed, renderEventLog, nextTuiMode, tuiModeFromEnv } from "../../src/runtime/tui.ts";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { completed, cp, loop, script, task, workflow } from "../engine/helpers.mjs";

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "pwf-journal-"));
  roots.push(root);
  return root;
}

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
      widget: undefined,
      setWidget: (id, value) => {
        ctx.ui.widget = value;
      },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-journal-store-"));
  return { pi, ctx, sent, entries, activeTools, read, storeRoot };
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

  const missingStart = project([started, { type: "node-failed", runId: "r", at: 4, key: "root/missing", reason: "dispatch failed" }].map((event) => parseEvent(event)));
  assert.equal(missingStart.status, "failed", "a failure remains authoritative when its start event is unavailable");
  assert.equal(missingStart.invocations["root/missing"].status, "failed");

  const resumed = fold(parkedView, parseEvent({ type: "run-resumed", runId: "r", at: 5 }));
  assert.equal(resumed.status, "running", "resuming a parked run returns the projection to running");
});

test("a run appends lifecycle events for start, agent nodes, and completion", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
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
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("node-started"), "the script start is journaled");
  assert.ok(types.includes("node-succeeded"), "the script success is journaled");
  assert.ok(types.lastIndexOf("node-started") > types.indexOf("node-succeeded"), "the run then waits at the next task");
});

test("a script-only run journals started through completed", async () => {
  const h = harness();
  const wf = workflow([script("only", { spec: { argv: ["node", "-e", "process.stdout.write('done')"], inheritEnv: ["PATH"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const types = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data.type);
  assert.deepEqual(types, ["run-started", "node-ready", "node-started", "node-log", "artifact-published", "node-succeeded", "artifact-published", "artifact-published", "run-completed"]);
});

test("restore replays persisted events into the projection", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);

  const restored = harness();
  restored.entries.push(...h.entries);
  const runtime2 = new RuntimeCoordinator(restored.pi, [wf], restored.read, restored.storeRoot);
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
  const runtime = new RuntimeCoordinator(h.pi, [simpleWorkflow()], h.read, h.storeRoot);
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
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
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

test("an injected script failure parks the run and the projection reports waiting with the reason", async () => {
  const h = harness();
  const wf = workflow([
    script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const eventsOf = () => h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const events = eventsOf();
  assert.ok(events.some((event) => event.type === "node-started" && event.key === "root/stuck" && event.attempt === 1), "the first attempt is journaled");
  const waiting = events.find((event) => event.type === "node-waiting" && event.key === "root/stuck");
  assert.ok(waiting, "the exhausted failure is journaled");
  assert.match(waiting.reason, /code 1/);
  const projection = project(events.map((event) => parseEvent(event)));
  assert.equal(projection.status, "waiting", "the parked failure keeps the projection waiting");
  assert.equal(projection.invocations["root/stuck"].status, "waiting");
  assert.match(projection.invocations["root/stuck"].lastReason, /code 1/);
  const snapshot = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active").at(-1);
  assert.equal(snapshot.data.parked, true, "the park marker is persisted");
  assert.equal(snapshot.data.execution.invocations["root/stuck"].status, "waiting");

  const result = await runtime.retry(undefined, h.ctx);
  assert.equal(result.details.status, "parked");
  const retried = eventsOf();
  assert.ok(retried.some((event) => event.type === "retry-scheduled" && event.key === "root/stuck" && event.attempt === 2), "the retry is journaled");
  const starts = retried.filter((event) => event.type === "node-started" && event.key === "root/stuck");
  assert.equal(starts.length, 2, "the retry journals a second start");
  assert.equal(starts[1].attempt, 2);
  const retriedProjection = project(retried.map((event) => parseEvent(event)));
  assert.equal(retriedProjection.status, "waiting", "the second failure parks again");
  assert.equal(retriedProjection.invocations["root/stuck"].attempts, 2, "the projection counts both attempts");
});

test("a runner-level input failure journals node-failed and fails the projection while the run stays active", async () => {
  const h = harness();
  const wf = workflow([
    task("gather"),
    script("consume", { spec: { argv: ["node", "-e", "process.exit(0)"], inheritEnv: ["PATH"] }, inputs: { x: { from: "gather", select: "/missing" } } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition({ status: "completed", checkpoint: cp("gathered", { files: ["a"] }) }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const failed = events.find((event) => event.type === "node-failed" && event.key === "root/consume");
  assert.ok(failed, "the unresolved input is journaled as node-failed");
  assert.match(failed.reason, /missing/);
  const projection = project(events.map((event) => parseEvent(event)));
  assert.equal(projection.status, "failed", "the node failure fails the run projection");
  assert.equal(projection.invocations["root/consume"].status, "failed");
  assert.match(projection.invocations["root/consume"].lastReason, /missing/);
  assert.equal(runtime.state.status, "active", "the run stays active at the failed position");
  assert.equal(runtime.state.parked, undefined, "a runner-level failure does not park the run");
});

test("new lifecycle events parse, fold, and stay bounded", () => {
  const longLog = "é".repeat(600);
  const raw = [
    { type: "run-started", runId: "rich", at: 100, workflow: "demo", target: "observe" },
    { type: "loop-iteration-started", runId: "rich", at: 110, key: "root/review", mode: "for-each", iteration: 2, total: 3 },
    { type: "node-ready", runId: "rich", at: 111, key: "root/review/loop[2]/check", runner: "agent", attempt: 1 },
    { type: "node-started", runId: "rich", at: 112, key: "root/review/loop[2]/check", runner: "agent", attempt: 1 },
    { type: "artifact-published", runId: "rich", at: 113, key: "root/review/loop[2]/check", output: "report", checksum: `sha256-${"a".repeat(64)}`, size: 42, mediaType: "application/json" },
    { type: "node-log", runId: "rich", at: 114, key: "root/review/loop[2]/check", stream: "stdout", message: longLog, truncated: false },
    { type: "node-failed", runId: "rich", at: 115, key: "root/review/loop[2]/check", reason: "exit 2" },
    { type: "retry-scheduled", runId: "rich", at: 116, key: "root/review/loop[2]/check", attempt: 2 },
    { type: "node-started", runId: "rich", at: 117, key: "root/review/loop[2]/check", runner: "agent", attempt: 2 },
    { type: "node-waiting", runId: "rich", at: 118, key: "root/review/loop[2]/check", reason: "manual repair" },
    { type: "node-skipped", runId: "rich", at: 119, key: "root/optional", runner: "agent", reason: "guard did not hold" },
  ];
  const events = raw.map((event) => parseEvent(event));
  assert.ok(events.every(Boolean), "every new event shape parses");
  const log = events.find((event) => event.type === "node-log");
  assert.ok(Buffer.byteLength(log.message, "utf8") <= 512, "log payloads are byte bounded");
  assert.equal(log.truncated, true, "parser records truncation when it clips a persisted log");
  assert.equal(parseEvent({ ...raw[1], iteration: 4 }), undefined, "loop iteration cannot exceed its total");
  const emptyLoop = project([
    parseEvent(raw[0]),
    parseEvent({ type: "loop-completed", runId: "rich", at: 120, key: "root/empty", mode: "for-each", iterations: 0, total: 0, exhausted: false }),
  ]);
  assert.equal(emptyLoop.loops["root/empty"].mode, "for-each", "zero-item loops retain their mode in the projection");

  const view = project(events);
  assert.equal(view.status, "waiting");
  assert.equal(view.invocations["root/review/loop[2]/check"].attempts, 2);
  assert.equal(view.invocations["root/review/loop[2]/check"].status, "waiting");
  assert.equal(view.invocations["root/optional"].status, "skipped");
  assert.equal(view.loops["root/review"].iteration, 2);
  assert.equal(view.artifacts[0].output, "report");
  assert.equal(view.logs[0].truncated, true);
});

test("the detailed projection renders hierarchy, iterations, attempts, logs, artifacts, and failures", () => {
  const events = [
    { type: "run-started", runId: "detail", at: 1_000, workflow: "demo", target: "ship" },
    { type: "loop-iteration-started", runId: "detail", at: 1_100, key: "root/review", mode: "for-each", iteration: 2, total: 4 },
    { type: "node-ready", runId: "detail", at: 1_110, key: "root/review/loop[2]/verify", runner: "process", attempt: 2 },
    { type: "node-started", runId: "detail", at: 1_120, key: "root/review/loop[2]/verify", runner: "process", attempt: 2 },
    { type: "node-log", runId: "detail", at: 1_130, key: "root/review/loop[2]/verify", stream: "stderr", message: "check failed", truncated: false },
    { type: "artifact-published", runId: "detail", at: 1_140, key: "root/review/loop[2]/verify", output: "stderr", checksum: `sha256-${"b".repeat(64)}`, size: 12, mediaType: "text/plain" },
    { type: "node-waiting", runId: "detail", at: 1_150, key: "root/review/loop[2]/verify", reason: "retry approval required" },
  ].map((event) => parseEvent(event));
  const projection = project(events);
  const details = renderDetailed(projection, "demo: review").join("\n");
  assert.match(details, /root\/review \[loop for-each\] iteration=2\/4/);
  assert.match(details, /root\/review\/loop\[2\]\/verify \[process\] attempt=2 state=waiting/);
  assert.match(details, /reason=retry approval required/);
  assert.match(details, /logs:[\s\S]*stderr: check failed/);
  assert.match(details, /artifacts:[\s\S]*verify\/stderr 12B/);
});

test("runtime emits ready, skipped, loop iteration, loop completion, and artifact events", async () => {
  const h = harness();
  const wf = workflow([
    task("gather"),
    task("optional", { guard: { from: "gather", select: "/data/runOptional", op: "equals", value: true } }),
    loop("review", "for-each"),
    task("deliver"),
  ], { overviewPath: join(tempDir(), "WORKFLOW.md") });
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition({ status: "completed", checkpoint: cp("gathered", { files: ["a"], runOptional: false }) }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  let events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  assert.ok(events.some((event) => event.type === "node-ready" && event.key === "root/gather"));
  assert.ok(events.some((event) => event.type === "node-skipped" && event.key === "root/optional"));
  assert.ok(events.some((event) => event.type === "loop-iteration-started" && event.key === "root/review" && event.iteration === 1 && event.total === 1));

  await runtime.transition({ status: "completed", checkpoint: cp("reviewed", { ok: true }) }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  assert.ok(events.some((event) => event.type === "artifact-published" && event.key === "root/review" && event.output === "1/review-step"));
  assert.ok(events.some((event) => event.type === "loop-completed" && event.key === "root/review" && event.iterations === 1));

  runtime.cycleTuiMode(h.ctx);
  assert.ok(h.ctx.ui.widget.some((line) => line === "tree:"), "detailed mode uses the projected hierarchy widget");
  assert.ok(h.ctx.ui.widget.some((line) => /root\/review/.test(line)), "the widget includes the loop and its body");
});

test("process logs and their durable artifacts are emitted into the projection", async () => {
  const h = harness();
  const wf = workflow([
    script("probe", { spec: { argv: ["node", "-e", "process.stdout.write('hello journal')"], inheritEnv: ["PATH"] } }),
  ], { overviewPath: join(tempDir(), "WORKFLOW.md") });
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  assert.ok(events.some((event) => event.type === "node-log" && event.key === "root/probe" && event.message === "hello journal"));
  assert.ok(events.some((event) => event.type === "artifact-published" && event.key === "root/probe" && event.output === "stdout"));
  const report = runtime.inspect();
  assert.equal(report.projection.logs.at(-1).message, "hello journal");
  assert.ok(report.projection.artifacts.some((artifact) => artifact.key === "root/probe" && artifact.output === "stdout"));
});

test("inspect keeps completed run history and restores it without an active run", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const started = await runtime.startWorkflow(h.ctx, wf, "history target");
  const runId = started.execution.runId;
  await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", checkpoint: cp("delivered") }, undefined, h.ctx);
  const completedReport = runtime.inspect();
  assert.equal(completedReport.runId, runId);
  assert.equal(completedReport.projection.status, "succeeded");
  assert.ok(completedReport.events.some((line) => /completed/.test(line)));

  const restored = harness();
  restored.entries.push(...h.entries);
  const runtime2 = new RuntimeCoordinator(restored.pi, [wf], restored.read, restored.storeRoot);
  runtime2.handleSessionStart(restored.ctx);
  const restoredReport = runtime2.inspect(runId);
  assert.equal(restoredReport.projection.status, "succeeded");
  assert.equal(restoredReport.projection.target, "history target");
  assert.equal(runtime2.inspect("missing-run"), undefined);
});

test("loop events include iterations traversed entirely through skipped body steps", async () => {
  const h = harness();
  const wf = workflow([
    task("gather"),
    loop("review", "for-each", {
      body: { guard: { from: "gather", select: "/data/runBody", op: "equals", value: true } },
    }),
    task("deliver"),
  ], { overviewPath: join(tempDir(), "WORKFLOW.md") });
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition({ status: "completed", checkpoint: cp("gathered", { files: ["a", "b"], runBody: false }) }, undefined, h.ctx);
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  const iterations = events.filter((event) => event.type === "loop-iteration-started" && event.key === "root/review");
  assert.deepEqual(iterations.map((event) => [event.iteration, event.total]), [[1, 2], [2, 2]]);
  assert.ok(events.some((event) => event.type === "node-skipped" && event.key === "root/review/loop[1]/review-step"));
  assert.ok(events.some((event) => event.type === "node-skipped" && event.key === "root/review/loop[2]/review-step"));
  assert.ok(events.some((event) => event.type === "loop-completed" && event.iterations === 2));
});
