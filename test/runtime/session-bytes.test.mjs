import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { ROLLOVER_COMMAND, TRANSFER_ENTRY_TYPE } from "../../src/runtime/transfer.ts";
import { activeSnapshot, deliveredTombstone, isDeliveredTombstone } from "../../src/persistence/snapshot.ts";
import { latestSnapshot, snapshotBytesInBranch, SnapshotByteBudgetReached } from "../../src/persistence/store.ts";
import { LIMITS } from "../../src/domain/limits.ts";
import { workflow, task, cp } from "../engine/helpers.mjs";
import { start } from "../../src/engine/interpreter.ts";

const SNAPSHOT_TYPE = "choreograph";
const simpleWorkflow = () => workflow([task("frame", { done: ["framed"] }), task("deliver")]);

function harness(options = {}) {
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => {
      // Real SessionManager JSONL serializes on append; clone so later engine
      // mutations of the live execution cannot rewrite committed history.
      entries.push({ type: "custom", customType: type, data: structuredClone(data) });
    },
    sendUserMessage: async (message) => {
      entries.sent ??= [];
      entries.sent.push(message);
    },
  };
  const session = { getBranch: () => entries };
  if (options.rollover) {
    session.getSessionDir = () => h.storeRoot;
    session.getSessionFile = () => join(h.storeRoot, "session.jsonl");
  }
  const h = {
    pi,
    entries,
    sent: () => entries.sent ?? [],
    activeTools,
    read: () => "# instructions",
    storeRoot: mkdtempSync(join(tmpdir(), "pwf-bytes-")),
    ctx: null,
  };
  h.ctx = {
    ui: { notices: [], setStatus() {}, notify(message, level) { this.notices.push({ message, level }); } },
    sessionManager: session,
  };
  return h;
}

function coordinator(h, workflows) {
  return new RuntimeCoordinator(h.pi, workflows, h.read, h.storeRoot);
}

async function withBudget(bytes, run) {
  const previous = LIMITS.snapshotBytesPerSession;
  LIMITS.snapshotBytesPerSession = bytes;
  try {
    await run();
  } finally {
    LIMITS.snapshotBytesPerSession = previous;
  }
}

async function deliveredRun(h, wf) {
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  return runtime;
}

/** Blocks at root/frame repeatedly; every stay transition commits one full-state snapshot. */
async function pumpBlocked(runtime, h) {
  let result;
  for (let i = 0; i < 20; i += 1) {
    await runtime.handleAgentSettled(h.ctx);
    result = await runtime.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, h.ctx);
    if (result.details.status !== "blocked") break;
  }
  return result;
}

const entry = (data) => ({ type: "custom", customType: SNAPSHOT_TYPE, data });

test("snapshot commits stop at the per-session byte budget and the pause reports bytes", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  await withBudget(4000, async () => {
    const runtime = await deliveredRun(h, wf);
    const result = await pumpBlocked(runtime, h);
    assert.equal(result.details.status, "snapshot-byte-cap");
    assert.ok(result.isError);
    assert.match(result.content[0].text, /snapshot log reached \d+ of 4000 bytes/);
    assert.match(result.content[0].text, /LIMITS\.snapshotBytesPerSession/);
    assert.equal(result.details.snapshotBytesBudget, 4000);
    assert.ok(result.details.snapshotBytes > 4000, "the rejected total is the one that crossed the budget");
    assert.equal(result.details.position, "root/frame", "the rejected transition left the run in place");
    const before = h.entries.length;
    const again = await runtime.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, h.ctx);
    assert.equal(again.details.status, "snapshot-byte-cap");
    assert.equal(h.entries.length, before, "a rejected commit writes nothing");
    assert.ok(runtime.committedSnapshotBytes <= 4000, "committed bytes never exceed the budget");
    assert.equal(runtime.committedSnapshotBytes, snapshotBytesInBranch(h.entries));
  });
});

test("a rollover-capable host rolls to a fresh session at the byte budget", async () => {
  const h = harness({ rollover: true });
  const wf = simpleWorkflow();
  await withBudget(4000, async () => {
    const runtime = await deliveredRun(h, wf);
    const result = await pumpBlocked(runtime, h);
    assert.equal(result.details.status, "rollover-pending");
    assert.equal(result.terminate, true);
    assert.match(result.content[0].text, /snapshot log reached \d+ of 4000 bytes/);
    assert.match(h.sent().at(-1), new RegExp(ROLLOVER_COMMAND));
    assert.ok(h.entries.some((item) => item.customType === TRANSFER_ENTRY_TYPE && item.data.kind === "rollover-prepared"));
    assert.ok(
      h.entries.some((item) => item.customType === SNAPSHOT_TYPE && item.data.status === "rollover-pending"),
      "the rollover marker commits even at the byte budget",
    );
  });
});

test("each commit records its serialized byte size and restore continues the accounting", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = await deliveredRun(h, wf);
  for (let i = 0; i < 3; i += 1) {
    await runtime.handleAgentSettled(h.ctx);
    await runtime.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, h.ctx);
  }
  const snapshots = h.entries.filter((item) => item.customType === SNAPSHOT_TYPE);
  const log = [...runtime.snapshotCommitBytes];
  assert.equal(log.length, snapshots.length, "one byte record per commit");
  assert.equal(log.reduce((total, bytes) => total + bytes, 0), runtime.committedSnapshotBytes);
  assert.ok(log.every((bytes) => Number.isInteger(bytes) && bytes > 0));
  assert.equal(log.at(-1), Buffer.byteLength(JSON.stringify(snapshots.at(-1).data), "utf8"));

  const fresh = harness();
  fresh.entries.push(...h.entries);
  const restored = coordinator(fresh, [wf]);
  restored.handleSessionStart(fresh.ctx);
  assert.equal(restored.snapshotCommitBytes.length, 0, "the byte log restarts with the session");
  assert.equal(restored.committedSnapshotBytes, snapshotBytesInBranch(fresh.entries), "restore continues from on-disk bytes");
  await restored.handleAgentSettled(fresh.ctx);
  const before = fresh.entries.length;
  await restored.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, fresh.ctx);
  assert.equal(fresh.entries.length, before + 1);
  assert.equal(restored.snapshotCommitBytes.length, 1);
  assert.equal(restored.committedSnapshotBytes, snapshotBytesInBranch(fresh.entries));
});

test("a resumed session pauses at the byte budget restored from its branch", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = await deliveredRun(h, wf);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, h.ctx);
  const diskBytes = snapshotBytesInBranch(h.entries);
  assert.ok(diskBytes > 0);

  const fresh = harness();
  fresh.entries.push(...h.entries);
  const restored = coordinator(fresh, [wf]);
  await withBudget(diskBytes, async () => {
    restored.handleSessionStart(fresh.ctx);
    assert.equal(restored.committedSnapshotBytes, diskBytes, "the restored session inherits the branch bytes");
    const result = await restored.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, fresh.ctx);
    assert.equal(result.details.status, "snapshot-byte-cap");
    assert.equal(fresh.entries.length, h.entries.length, "the crossing commit was rejected, not written");
  });
});

test("delivered markers are O(1) tombstones", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = await deliveredRun(h, wf);
  const snapshots = h.entries.filter((item) => item.customType === SNAPSHOT_TYPE);
  const marker = snapshots.at(-1).data;
  assert.ok(isDeliveredTombstone(marker));
  const runId = snapshots[0].data.execution.runId;
  assert.deepEqual(marker, deliveredTombstone(runId));
  const markerBytes = Buffer.byteLength(JSON.stringify(marker), "utf8");
  const stateBytes = Buffer.byteLength(JSON.stringify(snapshots[0].data), "utf8");
  assert.ok(markerBytes < 200, `marker is ${markerBytes} bytes`);
  assert.ok(markerBytes < stateBytes / 2, "the marker no longer carries the full state");
});

test("resume accepts both delivered-marker formats with identical state on both host kinds", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = await deliveredRun(h, wf);
  await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const snapshots = h.entries.filter((item) => item.customType === SNAPSHOT_TYPE);
  const activeSnapshotData = snapshots.at(-2).data;
  const tombstone = snapshots.at(-1).data;
  assert.equal(activeSnapshotData.delivered, false, "the last active snapshot precedes its delivery marker");
  assert.ok(isDeliveredTombstone(tombstone));
  const legacyMarker = { ...activeSnapshotData, delivered: true };
  // Each restored session reads its own serialized copy, as it would from JSONL.
  const newBranch = [entry(structuredClone(activeSnapshotData)), entry(tombstone)];
  const legacyBranch = [entry(structuredClone(activeSnapshotData)), entry(legacyMarker)];

  for (const rollover of [false, true]) {
    const restoredNew = harness({ rollover });
    restoredNew.entries.push(...newBranch.map((item) => ({ ...item, data: structuredClone(item.data) })));
    const newRuntime = coordinator(restoredNew, [wf]);
    newRuntime.handleSessionStart(restoredNew.ctx);
    const restoredLegacy = harness({ rollover });
    restoredLegacy.entries.push(...legacyBranch.map((item) => ({ ...item, data: structuredClone(item.data) })));
    const legacyRuntime = coordinator(restoredLegacy, [wf]);
    legacyRuntime.handleSessionStart(restoredLegacy.ctx);

    const promptNew = newRuntime.handleBeforeAgentStart({ systemPrompt: "base" });
    const promptLegacy = legacyRuntime.handleBeforeAgentStart({ systemPrompt: "base" });
    assert.ok(promptNew, `new-format resume on a ${rollover ? "rollover-capable" : "plain"} host`);
    assert.ok(promptLegacy, `legacy resume on a ${rollover ? "rollover-capable" : "plain"} host`);
    assert.equal(promptNew.systemPrompt, promptLegacy.systemPrompt, "tombstone resume equals legacy resume");
    const outcome = await newRuntime.transition({ key: "root/deliver", status: "blocked", checkpoint: cp("stuck") }, undefined, restoredNew.ctx);
    assert.ok(!outcome.isError, "the tombstone-restored run counts as delivered");
  }
});

test("a tombstone naming another run does not flip delivery", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const state = start(wf, { runId: "r1" }).state;
  const activeFalse = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  h.entries.push(entry(activeFalse), entry(deliveredTombstone("r2")));
  const runtime = coordinator(h, [wf]);
  runtime.handleSessionStart(h.ctx);
  const outcome = await runtime.transition({ key: "root/frame", status: "blocked", checkpoint: cp("stuck") }, undefined, h.ctx);
  assert.ok(outcome.isError);
  assert.match(outcome.content[0].text, /before its instructions are delivered/);
});

test("latestSnapshot folds tombstones and keeps the legacy format working", () => {
  const wf = simpleWorkflow();
  const state = start(wf, { runId: "r1" }).state;
  const activeFalse = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const activeTrue = activeSnapshot({ workflow: wf.name, execution: state, delivered: true });
  assert.equal(latestSnapshot([entry(activeFalse), entry(deliveredTombstone("r1"))]).delivered, true);
  assert.equal(latestSnapshot([entry(deliveredTombstone("r1")), entry(activeFalse)]).delivered, false, "a marker older than the snapshot is stale");
  assert.equal(latestSnapshot([entry(activeFalse), entry(deliveredTombstone("r2"))]).delivered, false, "a foreign-run marker is ignored");
  assert.equal(latestSnapshot([entry(activeTrue)]).delivered, true, "the legacy format keeps working");
  assert.equal(latestSnapshot([]), null);
});

test("snapshotBytesInBranch sums snapshot payloads only", () => {
  const wf = simpleWorkflow();
  const state = start(wf, { runId: "r1" }).state;
  const activeFalse = activeSnapshot({ workflow: wf.name, execution: state, delivered: false });
  const marker = deliveredTombstone("r1");
  const branch = [{ type: "message", message: { role: "user" } }, entry(activeFalse), entry(marker)];
  assert.equal(
    snapshotBytesInBranch(branch),
    Buffer.byteLength(JSON.stringify(activeFalse), "utf8") + Buffer.byteLength(JSON.stringify(marker), "utf8"),
  );
  assert.equal(snapshotBytesInBranch([]), 0);
});

test("SnapshotByteBudgetReached carries the budget and crossing bytes", () => {
  const error = new SnapshotByteBudgetReached(LIMITS.snapshotBytesPerSession, LIMITS.snapshotBytesPerSession + 1000);
  assert.equal(error.name, "SnapshotByteBudgetReached");
  assert.equal(error.budget, LIMITS.snapshotBytesPerSession);
  assert.equal(error.bytes, LIMITS.snapshotBytesPerSession + 1000);
  assert.match(error.message, /snapshot log would exceed/);
});
