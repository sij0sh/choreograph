import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { ArtifactStore } from "../../src/runtime/artifact-store.ts";
import { completed, cp, script, task, workflow } from "../engine/helpers.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "pwf-park-"));
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
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-park-store-"));
  return { pi, ctx, sent, entries, activeTools, read, storeRoot };
}

function scriptWorkflow() {
  return workflow([
    script("probe", { spec: { argv: ["node", "-e", "process.stdout.write(JSON.stringify({ answer: 42 }))"], inheritEnv: ["PATH"], stdout: "json" } }),
    task("deliver"),
  ]);
}

test("a script step drives to completion without any model turn", async () => {
  const h = harness();
  const wf = scriptWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "deliver", "the coordinator drove the script and advanced to the task");
  assert.equal(h.sent.length, 1, "exactly one control message, for the task position");
  const checkpoints = run.execution.checkpoints;
  assert.deepEqual(checkpoints["root/probe"].data, { answer: 42 });
  const snapshots = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active");
  assert.ok(snapshots.some((entry) => entry.data.execution.checkpoints["root/probe"]), "the script checkpoint is persisted");
});

test("a script-only workflow completes without sending a model message", async () => {
  const h = harness();
  const wf = workflow([script("only", { spec: { argv: ["node", "-e", "process.stdout.write('done')"], inheritEnv: ["PATH"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.status, "completed");
  assert.equal(h.sent.length, 1, "only the completion summary is sent");
  assert.match(h.sent[0].message, /is complete/, "the single message is the summary request, not a control message");
});

test("workflow_transition is rejected at a script position", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "stuck", "the failed script parks the run");
  assert.ok(h.sent.length >= 1, "the parked run delivers a control message");
  const result = await runtime.transition({ status: "completed", checkpoint: { summary: "trying to move on" } }, undefined, h.ctx);
  assert.ok(result.isError);
  assert.match(result.content[0].text, /does not accept transitions/);
});

test("a parked script notifies the model through a delivered control message", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(h.sent.some((entry) => entry.message.includes("root/stuck")), "the park delivers a control message naming the position");
});

test("exhausted script retries park the run without a model turn in between", async () => {
  const h = harness();
  const wf = workflow([
    script("flaky", { spec: { argv: ["node", "-e", "process.stdout.write('x'.repeat(4))"], inheritEnv: ["PATH"], stdout: "json" }, recovery: { maxAttempts: 2, strategy: ["retry", "block"] } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.status, "active", "the run parks at the script after retries are exhausted");
  assert.equal(run.execution.stack.at(-1).blockId, "flaky");
  assert.match(h.sent.at(-1).message, /root\/flaky/, "the park is announced with one control message, not one per retry");
  assert.equal(h.sent.filter((entry) => !entry.message.includes("is complete")).length, 1);
});

test("a parked script persists a waiting invocation in the snapshot", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const snapshots = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active");
  assert.ok(
    snapshots.some((entry) => entry.data.execution.invocations?.["root/stuck"]?.status === "waiting"),
    "the park is persisted as a waiting invocation in the active snapshot",
  );
});

test("a parked script persists a waiting invocation and no parked marker", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const active = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active");
  assert.equal("parked" in active[0].data, false, "the pre-run snapshot at the script leaf is not parked");
  assert.ok(active.every((entry) => !("parked" in entry.data)), "no snapshot carries a parked marker");
  const parked = active.filter((entry) => entry.data.execution.invocations?.["root/stuck"]?.status === "waiting");
  assert.ok(parked.length >= 1, "the park is snapshotted as a waiting invocation");
  assert.equal(active.at(-1).data.delivered, true, "the park is marked delivered");
});

test("restore re-executes a script whose persisted invocation is still running", async () => {
  const dir = tempDir();
  const marker = join(dir, "runs.txt");
  const h = harness();
  const wf = workflow([
    script("probe", {
      spec: {
        argv: ["node", "-e", "require('node:fs').appendFileSync(process.env.MARKER, 'x\\n'); process.exit(1)"],
        inheritEnv: ["PATH"],
        env: { MARKER: marker },
      },
      recovery: { maxAttempts: 1, strategy: ["block"] },
    }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(readLines(marker), 1, "the first execution parks the run");

  const revivedHarness = harness();
  revivedHarness.entries.push(...h.entries);
  const last = revivedHarness.entries.filter((entry) => entry.customType === "choreograph").at(-1);
  last.data = structuredClone(last.data);
  last.data.delivered = false;
  last.data.execution.invocations["root/probe"] = { ...last.data.execution.invocations["root/probe"], status: "running" };
  const revived = new RuntimeCoordinator(revivedHarness.pi, [wf], revivedHarness.read, revivedHarness.storeRoot);
  revived.handleSessionStart(revivedHarness.ctx);
  await settle(revived, revivedHarness);
  await waitFor(() => readLines(marker) === 2 && revived.state.execution.invocations?.["root/probe"]?.status === "waiting");
  assert.equal(readLines(marker), 2, "a running script leaf is re-executed instead of inferred as parked");
  assert.equal(revived.state.execution.invocations?.["root/probe"]?.status, "waiting", "the re-executed failure parks again as a waiting invocation");
  const reparked = revivedHarness.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active").at(-1);
  assert.equal(reparked.data.execution.invocations?.["root/probe"]?.status, "waiting", "the re-park persists the waiting invocation again");
});

test("restore of a parked script run does not re-execute the script", async () => {
  const dir = tempDir();
  const marker = join(dir, "runs.txt");
  const h = harness();
  const wf = workflow([
    script("stuck", {
      spec: {
        argv: ["node", "-e", "require('node:fs').appendFileSync(process.env.MARKER, 'x\\n'); process.exit(1)"],
        inheritEnv: ["PATH"],
        env: { MARKER: marker },
      },
      recovery: { maxAttempts: 1, strategy: ["block"] },
    }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(readLines(marker), 1, "the script ran exactly once before parking");

  const revivedHarness = harness();
  revivedHarness.entries.push(...h.entries);
  const revived = new RuntimeCoordinator(revivedHarness.pi, [wf], revivedHarness.read, revivedHarness.storeRoot);
  revived.handleSessionStart(revivedHarness.ctx);
  await settle(revived, revivedHarness);
  assert.ok(revivedHarness.ctx.ui.notices.some((notice) => /Resumed/.test(notice.message)), "the run resumes");
  assert.equal(readLines(marker), 1, "restore does not re-execute the non-idempotent script");
  assert.equal(revivedHarness.sent.length, 0, "no duplicate park message is delivered; the original is already in the restored transcript");
  const last = revivedHarness.entries.filter((entry) => entry.customType === "choreograph").at(-1);
  assert.equal(last.data.status, "active", "the run stays active and parked");
  assert.equal(last.data.execution.invocations?.["root/stuck"]?.status, "waiting", "the restored snapshot carries the waiting invocation");
  assert.equal(last.data.execution.stack.at(-1).blockId, "stuck");
});

test("workflow_retry re-runs the parked script and parks again on another failure", async () => {
  const dir = tempDir();
  const marker = join(dir, "runs.txt");
  const h = harness();
  const wf = workflow([
    script("flaky", {
      spec: {
        argv: ["node", "-e", "require('node:fs').appendFileSync(process.env.MARKER, 'x\\n'); process.exit(1)"],
        inheritEnv: ["PATH"],
        env: { MARKER: marker },
      },
      recovery: { maxAttempts: 1, strategy: ["block"] },
    }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const result = await runtime.retry(undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.details.status, "parked");
  assert.equal(readLines(marker), 2, "the retry executed the script a second time");
  const last = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active").at(-1);
  assert.equal(last.data.execution.invocations?.["root/flaky"]?.status, "waiting", "the re-park after retry is persisted as a waiting invocation");
});

test("workflow_retry advances the run when the retried script succeeds", async () => {
  const dir = tempDir();
  const marker = join(dir, "first.txt");
  const h = harness();
  const wf = workflow([
    script("recovers", {
      spec: {
        argv: ["node", "-e", "const fs = require('node:fs'); if (fs.existsSync(process.env.MARKER)) { process.stdout.write('recovered'); } else { fs.writeFileSync(process.env.MARKER, '1'); process.exit(1); }"],
        inheritEnv: ["PATH"],
        env: { MARKER: marker },
      },
      recovery: { maxAttempts: 1, strategy: ["block"] },
    }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(runtime.state.execution.stack.at(-1).blockId, "recovers", "the first failure parks");
  const result = await runtime.retry(undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.details.status, "active");
  assert.equal(runtime.state.execution.stack.at(-1).blockId, "deliver", "the successful retry advances to the next task");
  const last = h.entries.filter((entry) => entry.customType === "choreograph").at(-1);
  assert.equal(last.data.execution.invocations?.["root/recovers"]?.status, "succeeded", "the successful retry records a succeeded invocation");
});

test("workflow_retry is rejected away from a parked script", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["f"] })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const result = await runtime.retry(undefined, h.ctx);
  assert.ok(result.isError);
  assert.equal(result.details.status, "not-script");
});

test("workflow_retry rejects while a script is still in flight", async () => {
  const dir = tempDir();
  const marker = join(dir, "inflight.txt");
  const h = harness();
  const wf = workflow([
    script("long", {
      spec: {
        argv: ["node", "-e", "require('node:fs').writeFileSync(process.env.MARKER, 'started\\n'); setInterval(() => {}, 1_000)"],
        inheritEnv: ["PATH"],
        env: { MARKER: marker },
        timeoutMs: 60_000,
      },
      recovery: { maxAttempts: 1, strategy: ["block"] },
    }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const started = runtime.startWorkflow(h.ctx, wf, "");
  await waitFor(() => exists(marker));
  const snapshotsBefore = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active").length;
  const result = await runtime.retry(undefined, h.ctx);
  assert.ok(result.isError, "the mid-flight retry is rejected");
  assert.match(result.content[0].text, /parked at a failed script/, "the rejection states the parked precondition");
  assert.equal(result.details.status, "not-script");
  assert.equal(
    h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active").length,
    snapshotsBefore,
    "no mid-flight snapshot is committed",
  );
  const invocation = runtime.state.execution.invocations?.["root/long"];
  assert.equal(invocation?.status, "running", "the script stays in flight on attempt 1");
  assert.equal(invocation?.attempt, 1, "no retry is scheduled");
  assert.ok(!h.sent.some((entry) => entry.message.includes("Retried process")), "no false completion reply is sent");
  await runtime.abort(undefined, h.ctx);
  await started;
});

test("abort cancels an in-flight script and terminates the process", async () => {
  const dir = tempDir();
  const marker = join(dir, "abort.txt");
  const h = harness();
  const wf = workflow([
    script("long", {
      spec: {
        argv: ["node", "-e", "require('node:fs').writeFileSync(process.env.MARKER, 'started\\n'); setInterval(() => {}, 1_000)"],
        inheritEnv: ["PATH"],
        env: { MARKER: marker },
        timeoutMs: 60_000,
      },
    }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const started = runtime.startWorkflow(h.ctx, wf, "");
  await waitFor(() => exists(marker));
  const result = await runtime.abort(undefined, h.ctx);
  await started;
  assert.equal(result.details.status, "aborted", "abort reports the terminal status");
  const terminal = h.entries.at(-1);
  assert.equal(terminal.data.status, "aborted", "the terminal snapshot is the last entry");
  assert.ok(!h.entries.some((entry) => entry.customType === "choreograph" && entry.data.status === "active" && entry.data.execution.checkpoints["root/long"]), "the cancelled script never commits a checkpoint");
});

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function exists(path) {
  return existsSync(path);
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.ok(predicate(), "condition was not met in time");
}

async function settle(runtime, ctx) {
  await runtime.handleAgentSettled(ctx);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}

test("restore with an undelivered park delivers the retry guidance", async () => {
  const h = harness();
  const wf = workflow([script("stuck", { spec: { argv: ["node", "-e", "process.exit(1)"], inheritEnv: ["PATH"] }, recovery: { maxAttempts: 1, strategy: ["block"] } })]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const parkSnapshot = h.entries
    .filter((entry) => entry.customType === "choreograph" && entry.data.status === "active" && entry.data.execution.invocations?.["root/stuck"]?.status === "waiting")
    .at(0);

  const revivedHarness = harness();
  revivedHarness.entries.push(parkSnapshot);
  const revived = new RuntimeCoordinator(revivedHarness.pi, [wf], revivedHarness.read, revivedHarness.storeRoot);
  revived.handleSessionStart(revivedHarness.ctx);
  await settle(revived, revivedHarness);
  assert.ok(
    revivedHarness.sent.some((entry) => entry.message.includes("workflow_retry") && entry.message.includes("root/stuck")),
    "an undelivered park delivers the retry-or-abort guidance naming the position",
  );
});

test("a script whose cwd escapes the workflow root is refused without spawning", (t) => {
  const h = harness();
  const root = mkdtempSync(join(tmpdir(), "pwf-contain-run-"));
  const outside = mkdtempSync(join(tmpdir(), "pwf-contain-out-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "escape"));
  symlinkSync(outside, join(root, "escape", "loop"));
  const wf = workflow(
    [script("escapee", { spec: { argv: ["node", "-e", "process.stdout.write('escaped')"], cwd: "escape/loop", inheritEnv: ["PATH"], maxAttempts: 1, recovery: { maxAttempts: 1, strategy: ["block"] } } })],
    { overviewPath: join(root, "WORKFLOW.md") },
  );
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  return runtime.startWorkflow(h.ctx, wf, "").then((run) => {
    assert.ok(run);
    assert.equal(run.execution.status, "active");
    assert.equal(run.execution.stack.at(-1).blockId, "escapee", "the refused script parks the run at its own position");
    const checkpoint = run.execution.checkpoints["root/escapee"];
    assert.match(checkpoint?.summary ?? "", /outside the workflow directory/, "the containment refusal is recorded in the failure summary");
  });
});

test("started runs persist the compiled definition digest", async () => {
  const h = harness();
  const wf = workflow([script("probe", { spec: { argv: ["node", "-e", "process.stdout.write('ok')"], inheritEnv: ["PATH"] } }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const started = h.entries.find((entry) => entry.customType === "choreograph" && entry.data.status === "active" && entry.data.execution.definitionDigest !== undefined);
  assert.ok(started, "the start snapshot carries the definition digest");
  assert.match(started.data.execution.definitionDigest, /^[0-9a-f]{64}$/);
});

test("restore refuses a run whose workflow definition changed under it", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["f"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  const active = h.entries.filter((entry) => entry.customType === "choreograph" && entry.data.status === "active");

  const revivedHarness = harness();
  revivedHarness.entries.push(...active);
  const revived = new RuntimeCoordinator(revivedHarness.pi, [wf], revivedHarness.read, revivedHarness.storeRoot);
  const changed = workflow([task("frame", { done: ["f"] }), task("deliver", { done: ["d"] })]);
  const revivedWithChanged = new RuntimeCoordinator(revivedHarness.pi, [changed], revivedHarness.read, revivedHarness.storeRoot);
  revivedWithChanged.handleSessionStart(revivedHarness.ctx);
  assert.ok(
    revivedHarness.ctx.ui.notices.some((notice) => /definition digest mismatch/.test(notice.message)),
    "restore reports the digest mismatch instead of resuming",
  );
  assert.equal(revivedHarness.entries.at(-1), active.at(-1), "no new snapshots were committed");
  void revived;
});

test("a script with declared inputs still drives through the runner", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("probe", { spec: { argv: ["node", "-e", "process.stdout.write(JSON.stringify({ answer: 42 }))"], inheritEnv: ["PATH"], stdout: "json" }, inputs: { id: { from: "frame", select: "/data/id" } } }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed", { id: "main.ts" }) }, undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(runtime.state.execution.stack.at(-1).blockId, "deliver", "resolvable inputs do not block the script");
  assert.deepEqual(runtime.state.execution.checkpoints["root/probe"].data, { answer: 42 });
});

test("declared script inputs arrive on the child's stdin as one JSON object", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("probe", {
      spec: {
        argv: ["node", "-e", "let b=''; process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ echo: JSON.parse(b) })))"],
        inheritEnv: ["PATH"],
        stdout: "json",
      },
      inputs: { id: { from: "frame", select: "/data/id" } },
    }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed", { id: "main.ts" }) }, undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(runtime.state.execution.stack.at(-1).blockId, "deliver", "the script consumed its stdin inputs");
  assert.deepEqual(runtime.state.execution.checkpoints["root/probe"].data, { echo: { id: "main.ts" } });
});

test("a script without inputs runs with an empty stdin", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("probe", {
      spec: {
        argv: ["node", "-e", "let b=''; process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ got: b.length })))"],
        inheritEnv: ["PATH"],
        stdout: "json",
      },
    }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed", {}) }, undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(runtime.state.execution.checkpoints["root/probe"].data, { got: 0 });
});

test("an unresolvable script input fails the node and parks the run at the script", async () => {
  const h = harness();
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("probe", { spec: { stdout: "json" }, inputs: { gone: { from: "frame", select: "/data/missing" } } }),
    task("deliver"),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  const result = await runtime.transition({ status: "completed", met: ["framed"], checkpoint: cp("framed", {}) }, undefined, h.ctx);
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(runtime.state.execution.stack.at(-1).blockId, "probe", "the run stays at the script");
  assert.equal(runtime.state.execution.checkpoints["root/probe"], undefined, "the script never ran");
  const notice = h.ctx.ui.notices.at(-1);
  assert.match(notice.message, /Script root\/probe could not run/);
  assert.match(notice.message, /input "gone"/);
});

test("script runs publish stdout and stderr log artifacts under the run directory", async () => {
  const root = tempDir();
  const wf = {
    ...workflow([
      script("probe", {
        spec: {
          argv: ["node", "-e", "process.stdout.write('logged output'); process.stderr.write('warn line');"],
          inheritEnv: ["PATH"],
        },
      }),
      task("deliver"),
    ]),
    overviewPath: join(root, "WORKFLOW.md"),
  };
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  const store = ArtifactStore.forRun(root, run.execution.runId);
  const objectsDir = join(store.rootDir, "objects");
  const contents = readdirSync(objectsDir).map((name) => readFileSync(join(objectsDir, name), "utf8"));
  assert.ok(contents.some((text) => text.includes("logged output")), "stdout is retained");
  assert.ok(contents.some((text) => text.includes("warn line")), "stderr is retained");
});

test("an oversized script output is stored and materialized into the next script's workspace", async () => {
  const root = tempDir();
  const big = JSON.stringify({ answer: 42, rows: Array.from({ length: 400 }, (_, index) => ({ id: index, note: "y".repeat(48) })) });
  const consumer = "let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const inputs=JSON.parse(raw);const stored=JSON.parse(require('node:fs').readFileSync(inputs.payload,'utf8'));process.stdout.write(String(stored.answer))});";
  const wf = {
    ...workflow([
      script("emit", { spec: { argv: ["node", "-e", `process.stdout.write(${JSON.stringify(big)})`], stdout: "json", inheritEnv: ["PATH"] } }),
      script("consume", { spec: { argv: ["node", "-e", consumer], inheritEnv: ["PATH"] }, inputs: { payload: { from: "emit", select: "/data" } } }),
      task("deliver"),
    ]),
    overviewPath: join(root, "WORKFLOW.md"),
  };
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "deliver", "both scripts ran without a model turn");
  const emitted = run.execution.checkpoints["root/emit"].data;
  assert.match(emitted.checksum, /^sha256-[0-9a-f]{64}$/);
  assert.ok(emitted.size >= big.length, "the ref records the full stored payload");
  const store = ArtifactStore.forRun(root, run.execution.runId);
  const loaded = store.load(emitted);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.deepEqual(JSON.parse(loaded.content.toString("utf8")), JSON.parse(big));
  assert.equal(run.execution.checkpoints["root/consume"].data.stdout, "42", "the consumer read the materialized artifact");
  assert.ok(existsSync(join(root, ".choreograph", "artifacts", emitted.checksum.slice("sha256-".length))), "the artifact was materialized into the consumer's workspace");
});

test("declared capture files are published to the artifact store and referenced in the data", async () => {
  const root = tempDir();
  const wf = {
    ...workflow([
      script("build", {
        spec: {
          argv: ["node", "-e", "require('node:fs').writeFileSync('out.txt', 'captured bytes');"],
          inheritEnv: ["PATH"],
          files: [{ name: "report", path: "out.txt" }],
        },
      }),
      task("deliver"),
    ]),
    overviewPath: join(root, "WORKFLOW.md"),
  };
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "deliver", "the script completed and advanced");
  const ref = run.execution.checkpoints["root/build"].data.files.report;
  assert.equal(ref.output, "report");
  assert.equal(ref.mediaType, "application/octet-stream");
  assert.match(ref.checksum, /^sha256-[0-9a-f]{64}$/);
  const store = ArtifactStore.forRun(root, run.execution.runId);
  const loaded = store.load(ref);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.equal(loaded.content.toString("utf8"), "captured bytes");
});

test("a capture file that cannot be read fails the step through its repair policy", async () => {
  const root = tempDir();
  const wf = {
    ...workflow([
      script("build", {
        recovery: { maxAttempts: 1 },
        spec: { inheritEnv: ["PATH"], files: [{ name: "report", path: "missing.txt" }] },
      }),
      task("deliver"),
    ]),
    overviewPath: join(root, "WORKFLOW.md"),
  };
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  assert.equal(run.execution.stack.at(-1).blockId, "build", "the run parks at the failed script");
  assert.match(run.execution.checkpoints["root/build"].summary, /capture file could not be published/);
});
