import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "./index.ts";

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeWorkflow(root, name, frontmatter, stepFiles) {
  const directory = join(root, name);
  mkdirSync(join(directory, "steps"), { recursive: true });
  for (const file of stepFiles) writeFileSync(join(directory, "steps", file), `# ${file}\n`);
  writeFileSync(join(directory, "WORKFLOW.md"), `---\ndescription: ${name} description\n${frontmatter}\n---\n\n# ${name}\n`);
  return directory;
}

const MODELED_FRONTMATTER = `model: base/default-model
steps:
  - path: steps/01-a.md
  - path: steps/02-b.md
    model: strong/model-b
  - path: steps/03-c.md`;

function writeModeled(root, name = "modeled") {
  return writeWorkflow(root, name, MODELED_FRONTMATTER, ["01-a.md", "02-b.md", "03-c.md"]);
}

function modelHarness(root, entries = [], options = {}) {
  const catalog = options.catalog ?? {
    "base/default-model": { provider: "base", id: "default-model" },
    "strong/model-b": { provider: "strong", id: "model-b" },
    "base/session-model": { provider: "base", id: "session-model" },
  };
  const activeTools = new Set(["read", "bash"]);
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const sent = [];
  const notices = [];
  const statuses = [];
  const modelCalls = [];
  let currentModel = { provider: "base", id: "session-model" };
  let setModelResult = options.setModelResult ?? true;
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    },
    sendUserMessage: (message, options) => sent.push({ message, options }),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  const ctx = {
    cwd: "/repo",
    sessionManager: { getBranch: () => [...entries] },
    isIdle: () => true,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (key, value) => statuses.push({ key, value }),
    },
    get model() {
      return currentModel;
    },
    modelRegistry: {
      find: (provider, modelId) => {
        const model = catalog[`${provider}/${modelId}`];
        return model ? { ...model } : undefined;
      },
    },
    setModel: async (model) => {
      modelCalls.push(`${model.provider}/${model.id}`);
      if (setModelResult) currentModel = model;
      return setModelResult;
    },
  };
  register(pi, root);
  return { commands, ctx, entries, handlers, modelCalls, notices, sent, setActiveTools: (names) => pi.setActiveTools(names), setModelResult: (value) => (setModelResult = value), statuses, tools };
}

async function startRun(run, name = "modeled") {
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  await run.commands.get(name).handler("", run.ctx);
}

async function pass(run, summary = "done") {
  return run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary } }, undefined, undefined, run.ctx);
}

test("start applies step 1's workflow default and completion restores the session model", async () => {
  const root = tempRoot("model-lifecycle-");
  writeModeled(root);
  const run = modelHarness(root);
  await startRun(run);
  assert.deepEqual(run.modelCalls, ["base/default-model"]);
  const snapshot = run.entries.at(-1).data;
  assert.equal(snapshot.restoreModel, "base/session-model", "restoreModel is captured on first application");
  assert.equal(run.modelCalls.length, 1);

  await pass(run);
  assert.deepEqual(run.modelCalls, ["base/default-model", "strong/model-b"], "step override applies on delivery");

  await pass(run);
  assert.equal(run.modelCalls.at(-1), "base/default-model", "step 3 falls back to the workflow default");

  const final = await pass(run);
  assert.equal(final.isError, undefined);
  assert.equal(run.modelCalls.at(-1), "base/session-model", "completion restores the captured session model");
  assert.deepEqual(run.entries.at(-1).data, { v: 2, status: "completed", workflow: "modeled", runId: run.entries.at(-1).data.runId, totalSteps: 3 });
});

test("abort restores the captured session model", async () => {
  const root = tempRoot("model-abort-");
  writeModeled(root);
  const run = modelHarness(root);
  await startRun(run);
  await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);
  assert.deepEqual(run.modelCalls, ["base/default-model", "base/session-model"]);
});

test("node positions keep the executor step's model", async () => {
  const root = tempRoot("model-nodes-");
  writeWorkflow(
    root,
    "dyn",
    `model: base/default-model
steps:
  - path: steps/01-plan.md
    kind: planner
    model: strong/model-b
  - path: steps/02-execute.md
    kind: executor
  - path: steps/03-verify.md`,
    ["01-plan.md", "02-execute.md", "03-verify.md"],
  );
  const directory = join(root, "dyn");
  mkdirSync(join(directory, "operators"), { recursive: true });
  writeFileSync(join(directory, "operators", "inspect.md"), "---\ndescription: Inspect.\n---\n\n# Inspect\n");
  const run = modelHarness(root);
  await startRun(run, "dyn");
  assert.deepEqual(run.modelCalls, ["strong/model-b"], "the planner step's override applies at start");
  const plan = { version: 1, nodes: [ { id: "n-one", operator: "inspect", objective: "look", done: ["one-done"] }, { id: "n-two", operator: "inspect", objective: "look more", done: ["two-done"] } ] };
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "plan", data: { plan } } }, undefined, undefined, run.ctx);
  assert.equal(run.modelCalls.at(-1), "base/default-model", "node delivery applies the executor step's model");
  await pass(run);
  assert.equal(run.modelCalls.at(-1), "base/default-model", "node positions keep the executor step's model");
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["two-done"], checkpoint: { summary: "done" } }, undefined, undefined, run.ctx);
  assert.equal(run.modelCalls.at(-1), "base/default-model");
});

test("resume re-applies the current position's model without restoring", async () => {
  const root = tempRoot("model-resume-");
  const directory = writeModeled(root);
  void directory;
  const first = modelHarness(root);
  await startRun(first);
  await pass(first);
  const run = modelHarness(root, [first.entries.at(-1)]);
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.deepEqual(run.modelCalls, ["strong/model-b"], "resume applies the current step's model only");
});

test("unknown selectors and failed setModel calls warn without blocking", async () => {
  const root = tempRoot("model-degrade-");
  writeWorkflow(root, "ghost", `model: ghost/missing\nsteps:\n  - path: steps/01-a.md\n  - path: steps/02-b.md`, ["01-a.md", "02-b.md"]);
  const run = modelHarness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  assert.ok(run.notices.some((item) => /ghost\/missing is unavailable on this machine/.test(item.message) || /configured models are unavailable/.test(item.message)));
  await startRun(run, "ghost");
  assert.deepEqual(run.modelCalls, [], "unresolvable selectors never call setModel");
  assert.ok(run.notices.some((item) => /ghost\/missing is unavailable; keeping the current model/.test(item.message)));
  const moved = await pass(run);
  assert.equal(moved.isError, undefined, "the run proceeds");

  writeModeled(root);
  const failing = modelHarness(root, [], { setModelResult: false });
  await startRun(failing, "modeled");
  assert.deepEqual(failing.modelCalls, ["base/default-model"]);
  assert.ok(failing.notices.some((item) => /Could not switch to model base\/default-model/.test(item.message)));
  await failing.tools.get("workflow_abort").execute("call", {}, undefined, undefined, failing.ctx);
  assert.ok(failing.notices.some((item) => /Could not restore session model/.test(item.message)));
});

test("runs without configured models and legacy workflows never call setModel", async () => {
  const root = tempRoot("model-none-");
  writeWorkflow(root, "plain", `steps:\n  - path: steps/01-a.md\n  - path: steps/02-b.md`, ["01-a.md", "02-b.md"]);
  writeWorkflow(root, "legacy", `steps:\n  - steps/01-a.md\n  - steps/02-b.md`, ["01-a.md", "02-b.md"]);
  const run = modelHarness(root);
  await startRun(run, "plain");
  await pass(run);
  await pass(run);
  assert.deepEqual(run.modelCalls, [], "structured runs without selectors never call setModel");
  assert.equal(run.entries.at(-1).data.restoreModel, undefined);

  await run.commands.get("legacy").handler("", run.ctx);
  await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  assert.deepEqual(run.modelCalls, [], "legacy workflows never call setModel");
});

test("a malformed restoreModel drops the run with one warning", async () => {
  const root = tempRoot("model-restore-bad-");
  writeModeled(root);
  const run = modelHarness(root);
  run.entries.push({
    type: "custom",
    customType: "pi-workflows",
    data: { v: 3, status: "active", workflow: "modeled", runId: "bad", position: { kind: "step", stepId: "b" }, target: "", delivered: true, memory: { steps: {} }, restoreModel: "no-slash" },
  });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.notices.some((item) => /malformed snapshot/.test(item.message)));
  assert.deepEqual(run.modelCalls, []);
});
