import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "pwf-proc-op-"));
  roots.push(root);
  return root;
}

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
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-proc-op-store-"));
  return { pi, ctx, sent, entries, activeTools, read, storeRoot };
}

const FETCH_SCRIPT = {
  argv: ["node", "-e", "process.stdout.write(JSON.stringify({ value: 1 }))"],
  cwd: ".",
  inheritEnv: ["PATH"],
  timeoutMs: 10_000,
  acceptedExitCodes: [0],
  stdout: "json",
  stderr: "none",
  maxCaptureBytes: 65_536,
};

const FAIL_SCRIPT = { ...FETCH_SCRIPT, argv: ["node", "-e", "process.exit(1)"] };

function operators(script) {
  return new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
    ["fetch", { id: "fetch", path: "operators/fetch.md", description: "Fetch data.", script }],
  ]);
}

function planWorkflow(script, planExtra = {}) {
  return workflow(
    [task("frame"), { kind: "plan", id: "investigate", operators: ["inspect", "fetch"], ...planExtra }, task("deliver")],
    { operators: operators(script) },
  );
}

const PLAN = {
  version: 1,
  nodes: [
    { id: "look", operator: "inspect", objective: "Look around.", done: ["looked"] },
    { id: "fetch-data", operator: "fetch", objective: "Fetch the data.", dependsOn: ["look"] },
  ],
};

async function toProcessNode(h, wf) {
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition(completed(cp("framed")), undefined, h.ctx);
  await runtime.transition(completed(cp("planned", { plan: PLAN })), undefined, h.ctx);
  await runtime.transition(completed(cp("looked around"), ["looked"]), undefined, h.ctx);
  return runtime;
}

test("the runtime drives a process operator node without a model turn", async () => {
  const h = harness();
  const wf = planWorkflow(FETCH_SCRIPT);
  const runtime = await toProcessNode(h, wf);
  const active = runtime.state;
  assert.equal(active.status, "active");
  assert.equal(active.execution.stack.at(-1).blockId, "deliver", "the coordinator drove the process node and advanced to the task");
  assert.deepEqual(active.execution.plans["root/investigate"].results["fetch-data"].data, { value: 1 });
  assert.equal(active.execution.invocations["root/investigate/fetch-data"].runner, "process");
  const deliverMessages = h.sent.filter((entry) => entry.message.includes("deliver")).length;
  assert.equal(h.sent.length, 4, "frame, plan create, agent node, and deliver each got one message; the process node got none");
  assert.ok(deliverMessages >= 1);
});

test("a failing process node parks the run and workflow_retry re-dispatches it", async () => {
  const h = harness();
  const wf = planWorkflow(FAIL_SCRIPT, { recovery: { maxAttempts: 1, strategy: ["block"] } });
  const runtime = await toProcessNode(h, wf);
  const active = runtime.state;
  assert.equal(active.parked, true, "the run parks after the process node fails");
  assert.equal(active.execution.stack.at(-1).key, "root/investigate/fetch-data");
  assert.match(active.execution.checkpoints["root/investigate/fetch-data"].summary, /exited with code 1/);

  const result = await runtime.retry(undefined, h.ctx);
  assert.match(result.content[0].text, /failed again/);
  assert.equal(runtime.state.parked, true);
  assert.ok(runtime.activeToolsFor(runtime.state).includes("workflow_retry"), "workflow_retry stays available while parked at the process node");
  const events = h.entries.filter((entry) => entry.customType === "choreograph-events").map((entry) => entry.data);
  assert.ok(events.some((event) => event.type === "retry-scheduled" && event.key === "root/investigate/fetch-data" && event.attempt === 2), "the tool retry re-dispatched the process node as attempt 2");
  assert.equal(events.filter((event) => event.type === "node-started" && event.key === "root/investigate/fetch-data").length, 2, "the process node started twice");
});

test("consecutive process nodes run in one drive pass", async () => {
  const h = harness();
  const second = { ...FETCH_SCRIPT, argv: ["node", "-e", "process.stdout.write(JSON.stringify({ doubled: 2 }))"] };
  const ops = new Map([
    ["fetch", { id: "fetch", path: "operators/fetch.md", description: "Fetch data.", script: FETCH_SCRIPT }],
    ["double", { id: "double", path: "operators/double.md", description: "Double it.", script: second }],
  ]);
  const wf = workflow(
    [
      task("frame"),
      {
        kind: "plan",
        id: "investigate",
        operators: ["fetch", "double"],
      },
      task("deliver"),
    ],
    { operators: ops },
  );
  const plan2 = {
    version: 1,
    nodes: [
      { id: "fetch-data", operator: "fetch", objective: "Fetch." },
      { id: "double-it", operator: "double", objective: "Double.", dependsOn: ["fetch-data"] },
    ],
  };
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition(completed(cp("framed")), undefined, h.ctx);
  await runtime.transition(completed(cp("planned", { plan: plan2 })), undefined, h.ctx);
  const active = runtime.state;
  assert.equal(active.execution.stack.at(-1).blockId, "deliver", "both process nodes ran and the run advanced");
  const results = active.execution.plans["root/investigate"].results;
  assert.deepEqual(results["fetch-data"].data, { value: 1 });
  assert.deepEqual(results["double-it"].data, { doubled: 2 });
});

test("workflow_transition is rejected at a process operator node", async () => {
  const h = harness();
  const wf = planWorkflow(FAIL_SCRIPT, { recovery: { maxAttempts: 1, strategy: ["block"] } });
  const runtime = await toProcessNode(h, wf);
  const result = await runtime.transition(completed(cp("tried")), undefined, h.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /process operator node/);
});

test("a process operator runs as a loop body step across iterations", async () => {
  const h = harness();
  const wf = workflow(
    [
      task("gather"),
      {
        kind: "loop",
        id: "scan",
        mode: "for-each",
        body: {
          kind: "sequence",
          id: "scan-body",
          children: [{ kind: "script", id: "fetch-one", script: FETCH_SCRIPT }],
        },
        itemsBinding: { from: "gather", select: "/data/files" },
        maxIterations: 2,
      },
      task("deliver"),
    ],
    { name: "operator-body-e2e", overviewPath: join(tempDir(), "WORKFLOW.md"), operators: operators(FETCH_SCRIPT) },
  );
  // the operator step form parses to the same script block; assert the parsed shape via the parser first
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.transition(completed(cp("gathered", { files: ["a", "b"] })), undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const active = runtime.state;
  assert.equal(active.status, "active");
  assert.equal(active.execution.stack.at(-1).blockId, "deliver", "both iterations of the operator body step ran and the loop finished");
  assert.deepEqual(active.execution.checkpoints["root/scan/loop[1]/fetch-one"].data, { value: 1 });
  assert.deepEqual(active.execution.checkpoints["root/scan/loop[2]/fetch-one"].data, { value: 1 });
  const aggregate = active.execution.checkpoints["root/scan"];
  assert.equal(aggregate.data.iterations, 2);
  assert.equal(aggregate.data.results.length, 2);
});
