// corr-d5: the retention sweep defined "active" per-session while run dirs are
// shared across sessions, so the name match alone could evict another live
// session's run. An active-run marker written at store creation and cleared on
// every terminal release lets the sweep skip claimed dirs; markers orphaned by
// a crash are reported for manual reclaim (warn-and-manual policy).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../../src/domain/limits.ts";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { hasRunMarker, runMarkerPath, runMarkerState, clearRunMarker, writeRunMarker } from "../../src/runtime/run-marker.ts";
import { sweepRunArtifacts, sweepWorkflowArtifacts } from "../../src/runtime/retention.ts";
import { cp, task, workflow } from "../engine/helpers.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function agePath(path, ageMs, now = Date.now()) {
  utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
}

function makeRunDir(runsDir, name, ageMs = 0, now = Date.now()) {
  const dir = join(runsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "artifacts-placeholder"), "x");
  if (ageMs > 0) agePath(dir, ageMs, now);
  return dir;
}

function withRunBudget(keepRuns, run) {
  const previous = LIMITS.runArtifactsKeepRuns;
  LIMITS.runArtifactsKeepRuns = keepRuns;
  try {
    run();
  } finally {
    LIMITS.runArtifactsKeepRuns = previous;
  }
}

test("marker lifecycle: write, detect, clear, stale detection", () => {
  const runDir = join(tempDir("pwf-marker-"), "run-1");
  assert.equal(runMarkerState(runDir).present, false, "no marker before the first write");
  writeRunMarker(runDir, "run-1");
  assert.ok(existsSync(runMarkerPath(runDir)), "writeRunMarker creates the marker file");
  assert.ok(hasRunMarker(runDir));
  assert.deepEqual(runMarkerState(runDir), { present: true, stale: false }, "a fresh marker is not stale");
  const now = Date.now();
  agePath(runMarkerPath(runDir), LIMITS.activeMarkerGraceMs + 1_000, now);
  assert.deepEqual(runMarkerState(runDir, now), { present: true, stale: true }, "a marker past the grace window is stale");
  clearRunMarker(runDir);
  assert.ok(!hasRunMarker(runDir), "clearRunMarker removes the marker file");
});

test("the run sweep never evicts a marker-bearing dir even when it is the oldest", () => {
  const runsDir = join(tempDir("pwf-marker-sweep-"), ".choreograph", "runs");
  mkdirSync(runsDir, { recursive: true });
  const now = Date.now();
  makeRunDir(runsDir, "run-01", 40 * 60_000, now);
  makeRunDir(runsDir, "run-marked-old", 30 * 60_000, now);
  writeRunMarker(join(runsDir, "run-marked-old"), "run-marked-old");
  makeRunDir(runsDir, "run-03", 10 * 60_000, now);
  makeRunDir(runsDir, "run-active", 0, now);
  withRunBudget(3, () => {
    const outcome = sweepRunArtifacts(runsDir, "run-active");
    assert.deepEqual(outcome.evicted, ["run-01"], "only unmarked old dirs are evicted");
    assert.deepEqual(outcome.staleMarkers, [], "a fresh marker is not reported");
  });
  assert.ok(existsSync(join(runsDir, "run-marked-old")), "the marked run dir survives eviction");
  assert.ok(!existsSync(join(runsDir, "run-01")));
});

test("a stale marker is reported and its dir is kept for manual reclaim", () => {
  const runsDir = join(tempDir("pwf-marker-stale-"), ".choreograph", "runs");
  mkdirSync(runsDir, { recursive: true });
  const now = Date.now();
  const staleDir = makeRunDir(runsDir, "run-crashed", 60 * 60_000, now);
  writeRunMarker(staleDir, "run-crashed");
  agePath(runMarkerPath(staleDir), LIMITS.activeMarkerGraceMs + 60_000, now);
  makeRunDir(runsDir, "run-02", 30 * 60_000, now);
  makeRunDir(runsDir, "run-03", 5 * 60_000, now);
  withRunBudget(2, () => {
    const outcome = sweepRunArtifacts(runsDir, undefined);
    assert.deepEqual(outcome.evicted, ["run-02"], "the unmarked old dir is evicted around the stale one");
    assert.deepEqual(outcome.staleMarkers, ["run-crashed"], "the stale marker is reported");
  });
  assert.ok(existsSync(staleDir), "the stale-marked dir is never auto-evicted");
  assert.ok(existsSync(join(runsDir, "run-03")), "the newest unmarked dir survives");
});

test("sweepWorkflowArtifacts warns about stale active-run markers", () => {
  const root = tempDir("pwf-marker-notify-");
  const runsDir = join(root, ".choreograph", "runs");
  const staleDir = makeRunDir(runsDir, "run-crashed");
  writeRunMarker(staleDir, "run-crashed");
  agePath(runMarkerPath(staleDir), LIMITS.activeMarkerGraceMs + 60_000);
  const wf = workflow([task("frame", { done: ["framed"] })], { overviewPath: join(root, "WORKFLOW.md") });
  const notes = [];
  sweepWorkflowArtifacts([wf], undefined, "run-live", (message, level) => notes.push({ message, level }), wf);
  const warnings = notes.filter((note) => note.level === "warning");
  assert.equal(warnings.length, 1, `expected one stale-marker warning, got ${JSON.stringify(notes)}`);
  assert.match(warnings[0].message, /stale active-run marker/);
  assert.match(warnings[0].message, /run-crashed/);
});

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
    sendUserMessage: async (message, deliverAs) => sent.push({ message, deliverAs }),
  };
  const ctx = {
    ui: { status: undefined, notices: [], setStatus: (_id, value) => { ctx.ui.status = value; }, notify: (message, level) => ctx.ui.notices.push({ message, level }) },
    sessionManager: {
      getBranch: () => entries,
      ...(rollover ? { getSessionDir: () => tempDir("pwf-marker-dir-"), getSessionFile: () => join(tempDir("pwf-marker-file-"), "session.jsonl") } : {}),
    },
  };
  const read = () => "# instructions";
  const storeRoot = tempDir("pwf-marker-store-");
  return { pi, ctx, read, storeRoot };
}

const wf = workflow([task("frame", { done: ["framed"] })]);

async function startedRuntime(h) {
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "t");
  await runtime.handleAgentSettled(h.ctx);
  return runtime;
}

test("starting a run writes the active marker beside its artifacts", async () => {
  const h = harness();
  const runtime = await startedRuntime(h);
  const runId = runtime.state.execution.runId;
  assert.ok(hasRunMarker(join(h.storeRoot, ".choreograph", "runs", runId)), "the marker exists right after start");
});

test("completion clears the marker on the plain terminal path", async () => {
  const h = harness();
  const runtime = await startedRuntime(h);
  const runId = runtime.state.execution.runId;
  const key = runtime.state.execution.stack.at(-1).key;
  const result = await runtime.transition({ status: "completed", key, met: ["framed"], checkpoint: cp("framed the work", {}) }, undefined, h.ctx);
  assert.equal(result.details?.status, "completed");
  assert.ok(!hasRunMarker(join(h.storeRoot, ".choreograph", "runs", runId)), "the marker is gone after completion");
});

test("completion clears the marker on the rollover terminal path", async () => {
  const h = harness({ rollover: true });
  const runtime = await startedRuntime(h);
  const runId = runtime.state.execution.runId;
  const key = runtime.state.execution.stack.at(-1).key;
  const result = await runtime.transition({ status: "completed", key, met: ["framed"], checkpoint: cp("framed the work", {}) }, undefined, h.ctx);
  assert.equal(result.details?.status, "rollover-pending");
  assert.ok(!hasRunMarker(join(h.storeRoot, ".choreograph", "runs", runId)), "the marker is gone after the rollover release");
});

test("abort clears the marker (shared with the stopLocalRun release path)", async () => {
  const h = harness();
  const runtime = await startedRuntime(h);
  const runId = runtime.state.execution.runId;
  const result = await runtime.abort(undefined, h.ctx);
  assert.equal(result.details?.status, "aborted");
  assert.ok(!hasRunMarker(join(h.storeRoot, ".choreograph", "runs", runId)), "the marker is gone after abort");
});
