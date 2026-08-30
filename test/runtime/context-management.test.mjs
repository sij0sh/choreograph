import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { TRANSFER_ENTRY_TYPE } from "../../src/runtime/transfer.ts";
import { SNAPSHOT_TYPE } from "../../src/persistence/snapshot.ts";
import { summaryPrefix } from "../../src/runtime/prompts.ts";
import { cp, task, workflow } from "../engine/helpers.mjs";

function rolloverHarness(sessionDir) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: async (message, options) => sent.push({ message, options }),
  };
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "test", id: "model", contextWindow: 128_000, maxTokens: 8_192 },
    thinkingLevel: "low",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: {
      getBranch: () => entries,
      getSessionDir: () => sessionDir,
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
      getCwd: () => process.cwd(),
    },
  };
  return { pi, ctx, sent, entries };
}

test("an accepted position prepares a snapshot-only child-session transfer", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "choreograph-rollover-"));
  try {
    const h = rolloverHarness(sessionDir);
    const wf = workflow([task("first"), task("second")]);
    const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# instructions");
    runtime.handleSessionStart(h.ctx);
    await runtime.startWorkflow(h.ctx, wf, "target");

    const result = await runtime.transition({ status: "completed", checkpoint: cp("first done") }, undefined, h.ctx);
    assert.equal(result.details.status, "rollover-pending");
    assert.equal(result.terminate, true);
    assert.match(h.sent.at(-1).message, /^\/workflow-rollover /);

    const transfer = h.entries.findLast((entry) => entry.customType === TRANSFER_ENTRY_TYPE)?.data;
    assert.equal(transfer.kind, "rollover-prepared");
    assert.equal(transfer.v, 2);
    assert.equal(transfer.terminal, false);
    assert.equal("manifest" in transfer, false, "the transfer carries no handoff manifest");
    assert.equal("previousEpoch" in transfer, false, "the transfer carries no epoch projection");
    assert.match(transfer.digest, /^sha256-[0-9a-f]{64}$/, "the transfer digest is a sha256 checksum");
    assert.ok(transfer.snapshot);

    let switched;
    const commandCtx = {
      ...h.ctx,
      waitForIdle: async () => {},
      switchSession: async (path, options) => {
        switched = { path, options };
        return { cancelled: false };
      },
    };
    await runtime.performRollover(transfer.transferId, commandCtx);
    assert.ok(switched?.path);

    const child = SessionManager.open(switched.path);
    const childEntries = child.getEntries();
    assert.ok(childEntries.some((entry) => entry.type === "custom" && entry.customType === SNAPSHOT_TYPE), "the child carries the workflow snapshot");
    assert.ok(childEntries.some((entry) => entry.type === "custom" && entry.customType === TRANSFER_ENTRY_TYPE), "the child carries the rollover receipt");
    assert.equal(childEntries.some((entry) => entry.type === "custom" && entry.customType === "choreograph-handoff-manifest"), false, "the child carries no handoff manifest");
    assert.equal(childEntries.some((entry) => entry.type === "custom_message" && entry.customType === "choreograph-handoff"), false, "the child carries no handoff capsule");
    assert.equal(childEntries.some((entry) => entry.type === "custom_message" && entry.customType === "choreograph-epoch"), false, "the child carries no epoch projection");
    const snapshot = childEntries.findLast((entry) => entry.type === "custom" && entry.customType === SNAPSHOT_TYPE)?.data;
    assert.equal(snapshot.status, "active");
    assert.equal(snapshot.delivered, false);
    assert.equal("handoff" in snapshot, false, "the snapshot carries no handoff field");
    assert.equal("parked" in snapshot, false, "the snapshot carries no parked field");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("a completed run's terminal transfer delivers a report built from the execution", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "choreograph-report-"));
  try {
    const h = rolloverHarness(sessionDir);
    const wf = workflow([task("only", { done: ["only-done"] })]);
    const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# instructions");
    runtime.handleSessionStart(h.ctx);
    await runtime.startWorkflow(h.ctx, wf, "the target");
    const finished = await runtime.transition({ status: "completed", met: ["only-done"], checkpoint: cp("the only step finished") }, undefined, h.ctx);
    assert.equal(finished.details.status, "rollover-pending");

    const transfer = h.entries.findLast((entry) => entry.customType === TRANSFER_ENTRY_TYPE)?.data;
    assert.equal(transfer.terminal, true);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: async () => {},
      switchSession: async (path, options) => {
        await options?.withSession?.({ sendUserMessage: async (message) => h.sent.push({ message }) });
        return { cancelled: false };
      },
    };
    await runtime.performRollover(transfer.transferId, commandCtx);

    const report = h.sent.at(-1).message;
    assert.ok(report.startsWith(summaryPrefix(transfer.runId)), "the report request opens with the summary prefix");
    assert.match(report, /# Workflow report inputs/, "the report envelope is included");
    assert.match(report, /the only step finished/, "the report is built from the execution's checkpoints");
    assert.match(report, /Target: the target/, "the report carries the run target");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("a v1 transfer is ignored on restore", () => {
  const h = rolloverHarness(mkdtempSync(join(tmpdir(), "choreograph-v1-")));
  const legacy = {
    v: 1,
    kind: "rollover-prepared",
    transferId: "legacy",
    childSessionId: "child",
    runId: "run-1",
    workflow: "demo",
    terminal: false,
    snapshot: {},
    manifest: { v: 1, runId: "run-1", epoch: 1, genesis: {}, atomicHandoffs: [] },
    previousEpoch: "",
    seedDigest: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  };
  h.entries.push({ type: "custom", customType: TRANSFER_ENTRY_TYPE, data: legacy });
  h.ctx.ui.notify = () => {};
  const runtime = new RuntimeCoordinator(h.pi, [workflow([task("a")])], () => "# instructions");
  runtime.handleSessionStart(h.ctx);
  assert.equal(runtime.state.status, "idle", "the legacy transfer does not park the session");
});
