import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { transition as engineTransition, start as engineStart } from "../../src/engine/interpreter.ts";
import { memoryStore, cp, task, workflow } from "../engine/helpers.mjs";
import { LIMITS } from "../../src/domain/limits.ts";
import { SNAPSHOT_TYPE } from "../../src/persistence/snapshot.ts";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function harness(options = {}) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => {
      if (options.failAppend) throw options.failAppend;
      entries.push({ type: "custom", customType: type, data });
    },
    sendUserMessage: async (message, deliverAs) => {
      sent.push({ message, deliverAs });
    },
  };
  const ctx = {
    ui: {
      status: undefined,
      notices: [],
      setStatus: (_id, value) => {
        ctx.ui.status = value;
      },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-purity-store-"));
  roots.push(storeRoot);
  return { pi, ctx, sent, entries, read, storeRoot };
}

function frameWorkflow() {
  return workflow([task("frame", { done: ["framed"] }), task("deliver")], { overviewPath: join(tempDir("pwf-purity-wf-"), "WORKFLOW.md") });
}

async function startedRuntime(h, wf) {
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "t");
  assert.ok(run, "run started");
  await runtime.handleAgentSettled(h.ctx);
  return runtime;
}

function transitionParams(runtime) {
  const key = runtime.state.execution.stack.at(-1).key;
  return { status: "completed", key, met: ["framed"], checkpoint: cp("engine-purity-checkpoint", { plan: "x" }) };
}

test("corr-d1: an accepted engine transition leaves the input execution untouched", () => {
  const wf = frameWorkflow();
  const started = engineStart(wf, { runId: "20260101000000-deadbeef", target: "t" });
  assert.ok(started.ok, started.ok ? "" : started.error);
  const before = structuredClone(started.state);
  const result = engineTransition(wf, started.state, { type: "outcome", outcome: { status: "completed", key: "root/frame", met: ["framed"], checkpoint: cp("did the framing", { plan: "x" }) } }, memoryStore().sinkFor("root/frame"));
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.deepEqual(started.state, before, "the engine mutated its input execution");
});


test("corr-d1: a storage-refused transition changes nothing in the live execution", async () => {
  const wf = frameWorkflow();
  const failState = { error: null };
  const h = harness({ get failAppend() {
    return failState.error;
  } });
  const runtime = await startedRuntime(h, wf);
  const before = structuredClone(runtime.state.execution);
  failState.error = new Error("disk full (simulated transient)");
  const result = await runtime.transition(transitionParams(runtime), undefined, h.ctx);
  assert.equal(result.isError, true, "the transition was refused");
  assert.deepEqual(runtime.state.execution, before, "the refused transition mutated live state");
});

test("corr-d1: a cap-refused transition changes nothing in the live execution", async () => {
  const wf = frameWorkflow();
  const h = harness();
  // Fill one slot below the cap before the session starts, so restore counts
  // 255 and the run's start commit lands at 256; the transition then refuses.
  for (let index = 0; index < LIMITS.snapshotEntriesPerSession - 1; index += 1) {
    h.entries.push({ type: "custom", customType: SNAPSHOT_TYPE, data: { v: 7, status: "terminal" } });
  }
  const runtime = await startedRuntime(h, wf);
  const before = structuredClone(runtime.state.execution);
  const result = await runtime.transition(transitionParams(runtime), undefined, h.ctx);
  assert.equal(result.isError, true, "the transition was refused at the cap");
  assert.match(result.content[0].text, /not committed/);
  assert.deepEqual(runtime.state.execution, before, "the refused transition mutated live state");
});

test("corr-d1: a byte-budget-refused transition changes nothing in the live execution", async () => {
  const wf = frameWorkflow();
  const h = harness();
  const runtime = await startedRuntime(h, wf);
  const before = structuredClone(runtime.state.execution);
  const previous = LIMITS.snapshotBytesPerSession;
  LIMITS.snapshotBytesPerSession = 1;
  try {
    const result = await runtime.transition(transitionParams(runtime), undefined, h.ctx);
    assert.equal(result.isError, true, "the transition was refused at the byte budget");
    assert.deepEqual(runtime.state.execution, before, "the refused transition mutated live state");
  } finally {
    LIMITS.snapshotBytesPerSession = previous;
  }
});

test("corr-d1: a memory-bound refusal changes nothing in the live execution", async () => {
  const wf = frameWorkflow();
  const h = harness();
  const runtime = await startedRuntime(h, wf);
  const before = structuredClone(runtime.state.execution);
  const previous = LIMITS.memoryBytes;
  LIMITS.memoryBytes = 1;
  try {
    const result = await runtime.transition(transitionParams(runtime), undefined, h.ctx);
    assert.equal(result.isError, true, "the transition was refused at the memory bound");
    assert.deepEqual(runtime.state.execution, before, "the refused transition mutated live state");
  } finally {
    LIMITS.memoryBytes = previous;
  }
});

test("corr-d1: the checkpoint index rebuilds lazily for fresh checkpoints records", async () => {
  const wf = workflow([task("frame", { done: ["framed"] }), task("gather", { done: ["gathered"] }), task("deliver")], { overviewPath: join(tempDir("pwf-purity-wf2-"), "WORKFLOW.md") });
  const h = harness();
  const runtime = await startedRuntime(h, wf);
  // First transition: fresh checkpoints record, no index entry for it yet.
  const first = await runtime.transition({ status: "completed", key: "root/frame", met: ["framed"], checkpoint: cp("framed the problem") }, undefined, h.ctx);
  assert.ok(!first.isError, first.isError ? first.content[0].text : "first transition accepted");
  // The next envelope renders the newest checkpoint per block from the fresh record.
  const enriched = runtime.handleBeforeAgentStart({ systemPrompt: "" });
  assert.ok(enriched.systemPrompt.includes("framed the problem"), "the envelope sees checkpoints recorded into fresh checkpoints records");
});
