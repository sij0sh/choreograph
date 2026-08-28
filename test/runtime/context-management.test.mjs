import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { HANDOFF_MANIFEST_TYPE } from "../../src/runtime/handoff-store.ts";
import { EVENT_ENTRY_TYPE } from "../../src/runtime/journal.ts";
import { EPOCH_MESSAGE_TYPE, HANDOFF_MESSAGE_TYPE, isolateWorkflowContext } from "../../src/runtime/isolation.ts";
import { TRANSFER_ENTRY_TYPE } from "../../src/runtime/transfer.ts";
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

test("an accepted position prepares a bounded child-session transfer", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "choreograph-epochs-"));
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
    assert.equal(transfer.terminal, false);
    assert.equal(transfer.manifest.atomicHandoffs.length, 1);
    assert.equal(transfer.manifest.atomicHandoffs[0].summary, "first done");

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
    assert.ok(childEntries.some((entry) => entry.type === "custom" && entry.customType === HANDOFF_MANIFEST_TYPE));
    assert.ok(childEntries.some((entry) => entry.type === "custom" && entry.customType === EVENT_ENTRY_TYPE), "the child retains bounded run history");
    assert.ok(childEntries.some((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_MESSAGE_TYPE));
    assert.ok(childEntries.some((entry) => entry.type === "custom_message" && entry.customType === EPOCH_MESSAGE_TYPE));
    const snapshot = childEntries.findLast((entry) => entry.type === "custom" && entry.customType === "choreograph")?.data;
    assert.equal(snapshot.status, "active");
    assert.equal(snapshot.delivered, false);
    assert.equal(snapshot.handoff.epoch, transfer.manifest.epoch, "the atomic snapshot carries the transferred manifest");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("isolation retains protected handoff data around the latest epoch boundary", () => {
  const runId = "run-1";
  const capsule = { role: "custom", customType: HANDOFF_MESSAGE_TYPE, content: "genesis" };
  const priorEpoch = { role: "custom", customType: EPOCH_MESSAGE_TYPE, content: "prior" };
  const stale = { role: "assistant", content: [{ type: "text", text: "stale" }] };
  const boundary = { role: "user", content: `Continue workflow \`${runId}\` at next.` };
  const current = { role: "assistant", content: [{ type: "text", text: "current" }] };
  assert.deepEqual(isolateWorkflowContext([capsule, priorEpoch, stale, boundary, current], runId), [capsule, priorEpoch, boundary, current]);
});

test("isolation keeps a workflow compaction and drops capsules from other runs", () => {
  const runId = "run-1";
  const staleCapsule = { role: "custom", customType: HANDOFF_MESSAGE_TYPE, content: "old", details: { runId: "run-0" } };
  const currentCapsule = { role: "custom", customType: HANDOFF_MESSAGE_TYPE, content: "current", details: { runId } };
  const compaction = { role: "compactionSummary", summary: `# Protected workflow handoff capsule\n${runId}\ncompacted epoch` };
  const boundary = { role: "user", content: `Continue workflow \`${runId}\` at next.` };
  assert.deepEqual(isolateWorkflowContext([staleCapsule, currentCapsule, compaction, boundary], runId), [compaction, boundary]);
});
