import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { activeSnapshot, SNAPSHOT_TYPE } from "../../src/persistence/snapshot.ts";
import { SnapshotCapReached } from "../../src/persistence/store.ts";
import { start as engineStart } from "../../src/engine/interpreter.ts";
import { LIMITS } from "../../src/domain/limits.ts";
import { script, task, workflow } from "../engine/helpers.mjs";
import { notifyDriveFailure } from "../../src/runtime/commit-failures.ts";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function harness({ rollover = false } = {}) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, options) => {
      sent.push({ message, options });
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
    sessionManager: {
      getBranch: () => entries,
      ...(rollover ? { getSessionDir: () => tempDir("pwf-own-dir-"), getSessionFile: () => join(tempDir("pwf-own-file-"), "session.jsonl") } : {}),
    },
  };
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-own-store-"));
  roots.push(storeRoot);
  return { pi, ctx, sent, entries, read, storeRoot };
}

/** Fills the branch one slot below the cap so the run's start commit lands at the cap. */
function fillToCap(entries) {
  const filler = { type: "custom", customType: SNAPSHOT_TYPE, data: { v: 7, status: "terminal" } };
  entries.push(...Array.from({ length: LIMITS.snapshotEntriesPerSession - 1 }, () => ({ ...filler })));
}

function scriptWorkflow() {
  return workflow(
    [script("go"), task("deliver", { done: ["delivered"] })],
    { overviewPath: join(tempDir("pwf-own-wf-"), "WORKFLOW.md") },
  );
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function capFullBranch(h, wf) {
  const started = engineStart(wf, { runId: "20260101000000-deadbeef", target: "t" });
  assert.ok(started.ok, started.ok ? "" : started.error);
  const snapshot = activeSnapshot({ workflow: wf.name, execution: started.state, delivered: false });
  fillToCap(h.entries);
  // The active snapshot is the cap-full session's 256th and last entry, so
  // restore resumes it; the resumed drive's post-script commit then refuses.
  h.entries.push({ type: "custom", customType: SNAPSHOT_TYPE, data: snapshot });
}

test("corr-d2: restoring a cap-full parked run pauses with a notice instead of crashing the host", async () => {
  const h = harness();
  const wf = scriptWorkflow();
  capFullBranch(h, wf);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx); // resume fires the drive unobserved
  const resumed = await waitFor(() => h.ctx.ui.notices.some((n) => /Resumed Demo run/.test(n.message)));
  assert.ok(resumed, "the active snapshot at the cap was resumed");
  const paused = await waitFor(() => h.ctx.ui.notices.some((n) => /run is paused at root\/go/.test(n.message)));
  assert.ok(paused, "the resume drive failure reached the user as a pause notice");
  assert.equal(runtime.state.status, "active", "the run stays active and resumable");
  assert.equal(h.entries.length, LIMITS.snapshotEntriesPerSession, "no commit slipped past the cap");
});
test("corr-d2: a rollover-capable host resumes into the standard rollover handoff", async () => {
  const h = harness({ rollover: true });
  const wf = scriptWorkflow();
  capFullBranch(h, wf);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const rolled = await waitFor(() => runtime.state.status === "rollover-pending");
  assert.ok(rolled, "the resumed drive prepared the rollover");
  assert.ok(h.sent.some((item) => item.message.startsWith("/workflow-rollover")), "the handoff command was queued");
  assert.ok(h.ctx.ui.notices.some((n) => n.level === "info" && /continues in a fresh session/.test(n.message)), "the rollover notice was surfaced");
});

test("corr-d2: non-cap resume failures notify with their detail instead of escaping", () => {
  const notices = [];
  const ctx = { ui: { notify: (message, level) => notices.push({ message, level }) } };
  const wf = workflow([script("go")]);
  const execution = { stack: [{ key: "root/go" }] };
  const resume = { status: "active", workflow: wf, execution };
  const c = { state: resume, supportsSessionRollover: () => false, snapshotOf: () => ({}) };
  notifyDriveFailure(c, new Error("boom"), ctx, { workflow: wf.name, runId: "r" }, resume, "root/go");
  assert.match(notices[0].message, /boom/);
  assert.equal(notices[0].level, "error");
});

test("corr-d2: a rollover-preparation failure inside the notify twin falls back to a plain notify", () => {
  const notices = [];
  const ctx = { ui: { notify: (message, level) => notices.push({ message, level }) } };
  const wf = workflow([script("go")]);
  const execution = { stack: [{ key: "root/go" }] };
  const resume = { status: "active", workflow: wf, execution };
  const c = {
    state: resume,
    supportsSessionRollover: () => true,
    snapshotOf: () => ({}),
    prepareRollover: () => {
      throw new Error("rollover blew up");
    },
  };
  notifyDriveFailure(c, new SnapshotCapReached(LIMITS.snapshotEntriesPerSession), ctx, { workflow: wf.name, runId: "r" }, resume, "root/go");
  assert.match(notices[0].message, /rollover blew up/);
  assert.equal(notices[0].level, "error");
});

test("corr-d3: an embedded host whose completion commit fails notifies the pause text and keeps the run active", async () => {
  const h = harness();
  fillToCap(h.entries);
  const wf = workflow([script("only", { spec: { argv: ["node", "-e", "process.stdout.write('done')"], inheritEnv: ["PATH"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run, "the start itself commits at the last free slot; the completion commit refuses");
  const notified = await waitFor(() => h.ctx.ui.notices.some((n) => n.level === "error" && /terminal record was not committed/.test(n.message)));
  assert.ok(notified, "the dropped completion failure reached the user");
  assert.equal(runtime.state.status, "active", "the run stays active with its completion uncommitted");
});

test("corr-d3: a rollover host's completion result is not an error and never double-notifies", async () => {
  const h = harness({ rollover: true });
  fillToCap(h.entries);
  const wf = workflow([script("only", { spec: { argv: ["node", "-e", "process.stdout.write('done')"], inheritEnv: ["PATH"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  await waitFor(() => runtime.state.status === "rollover-pending");
  assert.equal(runtime.state.status, "rollover-pending", "completion prepared the rollover");
  assert.ok(!h.ctx.ui.notices.some((n) => /terminal record was not committed/.test(n.message)), "no spurious completion-failure notice on the rollover path");
});
