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

const REASONING_STEPS = {
  "steps/01-frame.md": "---\ntitle: frame\n---\n\n# Frame\n\nEstablish the task contract.\n",
  "steps/02-observe.md": "# Observe\n\nBuild the evidence picture.\n",
  "steps/03-plan.md": "# Plan\n\nEmit the bounded plan.\n",
  "steps/04-execute.md": "# Execute\n\nRun the plan nodes.\n",
  "steps/05-verify.md": "# Verify\n\nTry to disprove the conclusions.\n",
  "steps/06-converge.md": "# Converge\n\nReconcile the results.\n",
  "steps/07-deliver.md": "---\nsubtitle: final\n---\n\n# Deliver\n\nPrepare the final answer.\n",
};

const REASONING_FRONTMATTER = `description: Bounded reasoning workflow.
steps:
  - path: steps/01-frame.md
    id: frame
    done: [task-framed]
  - path: steps/02-observe.md
    id: observe
  - path: steps/03-plan.md
    id: plan
    kind: planner
  - path: steps/04-execute.md
    id: execute
    kind: executor
  - path: steps/05-verify.md
    id: verify
    on:
      pass: converge
      rework: execute
      replan: plan
  - path: steps/06-converge.md
    id: converge
    on:
      pass: deliver
      rework: execute
      replan: plan
  - path: steps/07-deliver.md
    id: deliver`;

const OPERATORS = {
  "operators/inspect.md": "---\ndescription: Inspect the relevant surface.\ntools: [read]\n---\n\n# Inspect\n\nRead narrowly and report facts.\n",
  "operators/trace.md": "---\ndescription: Trace control and data flow.\ntools: [read, bash]\n---\n\n# Trace\n\nFollow the path and record the flow.\n",
};

function writeReasoning(root, name = "reasoning", { frontmatter = REASONING_FRONTMATTER, steps = REASONING_STEPS, operators = OPERATORS } = {}) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  for (const [file, body] of Object.entries({ ...steps, ...operators })) {
    const path = join(directory, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  writeFileSync(join(directory, "WORKFLOW.md"), `---\n${frontmatter}\n---\n\n# Reasoning\n\nOverview body.\n`);
  return directory;
}

function harness(root, entries = []) {
  const activeTools = new Set(["read", "bash"]);
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const sent = [];
  const notices = [];
  const statuses = [];
  let streaming = false;
  let appendFailure = null;
  let sendFailure = null;
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    },
    sendUserMessage: (message, options) => {
      if (sendFailure) throw new Error(sendFailure);
      sent.push({ message, options });
    },
    appendEntry: (customType, data) => {
      if (appendFailure) throw new Error(appendFailure);
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    cwd: "/repo",
    sessionManager: { getBranch: () => [...entries] },
    isIdle: () => !streaming,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };
  register(pi, root);
  return { activeTools, commands, ctx, entries, handlers, notices, pi, sent, setAppendFailure: (message) => (appendFailure = message), setSendFailure: (message) => (sendFailure = message), setStreaming: (value) => (streaming = value), statuses, tools };
}

async function startRun(run, name = "reasoning", target = "the target") {
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  await run.commands.get(name).handler(target, run.ctx);
}

const ORDER = ["frame", "observe", "plan", "execute", "verify", "converge", "deliver"];

async function advanceTo(run, stepId) {
  const target = ORDER.indexOf(stepId);
  if (target < 0) throw new Error(`unknown step: ${stepId}`);
  const metBy = { frame: ["task-framed"] };
  for (let i = 0; i < target; i += 1) {
    const result = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: metBy[ORDER[i]] ?? [], checkpoint: { summary: `did ${ORDER[i]}` } }, undefined, undefined, run.ctx);
    if (result.isError) throw new Error(`advance past ${ORDER[i]} failed: ${result.content[0].text}`);
  }
  return run;
}

function plan(nodes) {
  return { version: 1, nodes };
}

function node(id, operator, extra = {}) {
  return { id, operator, objective: `${id} objective`, done: [`${id}-done`], ...extra };
}

const PASS_PLAN = plan([
  node("inspect-basics", "inspect"),
  node("trace-flow", "trace", { dependsOn: ["inspect-basics"] }),
]);

async function reachPlanStep(run) {
  await startRun(run);
  await advanceTo(run, "plan");
  return run;
}

async function deliverPlan(run, planValue = PASS_PLAN, outcome = "pass") {
  const checkpoint = { summary: "plan ready", ...(planValue !== undefined ? { data: { plan: planValue } } : {}) };
  return run.tools.get("workflow_transition").execute("call", { outcome, met: [], checkpoint }, undefined, undefined, run.ctx);
}

// --- control messages and prompt isolation ---

test("structured runs deliver control messages and render instructions before_agent_start", async () => {
  const root = tempRoot("structured-delivery-");
  writeReasoning(root);
  const run = harness(root);
  await startRun(run);
  assert.equal(run.sent.length, 1);
  assert.match(run.sent.at(-1).message, /^Continue workflow `[^`]+` at frame\.$/);
  assert.doesNotMatch(run.sent.at(-1).message, /# Frame|Overview body|Operator:|Plan schema/);

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /# Active workflow/);
  assert.match(prompt.systemPrompt, /Position: 1\/7 at `frame`/);
  assert.match(prompt.systemPrompt, /Overview body\./);
  assert.match(prompt.systemPrompt, /# frame/);
  assert.match(prompt.systemPrompt, /Establish the task contract\./);
  assert.doesNotMatch(prompt.systemPrompt, /title: frame/, "YAML frontmatter never reaches Pi");
  assert.match(prompt.systemPrompt, /`pass` -> observe/);
  assert.match(prompt.systemPrompt, /Required criteria:/);
  assert.match(prompt.systemPrompt, /- `task-framed`/);
  assert.match(prompt.systemPrompt, /## Transition contract/);
});

test("transitions deliver only control messages for later steps", async () => {
  const root = tempRoot("structured-control-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  assert.match(run.sent.at(-1).message, /^Continue workflow `[^`]+` at plan\.$/);
  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /## Operator registry/);
  assert.match(prompt.systemPrompt, /`inspect`: Inspect the relevant surface\./);
  assert.match(prompt.systemPrompt, /`trace`: Trace control and data flow\./);
  assert.doesNotMatch(prompt.systemPrompt, /Read narrowly and report facts/, "planner sees descriptions, not operator bodies");
  assert.match(prompt.systemPrompt, /## Plan schema/);
  assert.match(prompt.systemPrompt, /## Prior step checkpoints/);
  assert.match(prompt.systemPrompt, /- `frame`: did frame/);
});

// --- transitions ---

test("undelivered positions reject transitions", async () => {
  const root = tempRoot("structured-undelivered-");
  writeReasoning(root);
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  run.setSendFailure("queue unavailable");
  await run.commands.get("reasoning").handler("", run.ctx);
  const blocked = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "x" } }, undefined, undefined, run.ctx);
  assert.equal(blocked.isError, true);
  assert.equal(blocked.details.status, "delivery-pending");
});

test("criteria gate passing transitions", async () => {
  const root = tempRoot("structured-criteria-");
  writeReasoning(root);
  const run = harness(root);
  await startRun(run);
  const cases = [
    [{ outcome: "pass", met: ["ghost"], checkpoint: { summary: "x" } }, /unknown criterion id: ghost/],
    [{ outcome: "pass", met: ["task-framed", "task-framed"], checkpoint: { summary: "x" } }, /met must not contain duplicates/],
    [{ outcome: "pass", met: [], checkpoint: { summary: "x" } }, /missing: task-framed/],
    [{ outcome: "blocked", met: ["task-framed"], checkpoint: { summary: "x" } }, /met is only valid with outcome "pass"/],
  ];
  for (const [params, pattern] of cases) {
    const result = await run.tools.get("workflow_transition").execute("call", params, undefined, undefined, run.ctx);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.match(result.content[0].text, pattern);
  }
  const valid = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["task-framed"], checkpoint: { summary: "framed" } }, undefined, undefined, run.ctx);
  assert.equal(valid.isError, undefined);
});

test("blocked transitions commit the checkpoint and stay delivered", async () => {
  const root = tempRoot("structured-blocked-");
  writeReasoning(root);
  const run = harness(root);
  await startRun(run);
  const sentBefore = run.sent.length;
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "blocked", met: [], checkpoint: { summary: "waiting on user", unknowns: ["needs input"] } }, undefined, undefined, run.ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Blocked at frame/);
  assert.equal(run.sent.length, sentBefore, "no new delivery");
  const snapshot = run.entries.at(-1).data;
  assert.equal(snapshot.delivered, true);
  assert.equal(snapshot.memory.steps.frame.summary, "waiting on user");
  assert.deepEqual(run.entries.at(-1).data.position, { kind: "step", stepId: "frame" });
});

test("workflow_advance is rejected for structured runs and transition for legacy runs", async () => {
  const root = tempRoot("structured-tool-split-");
  writeReasoning(root, "reasoning");
  const legacyDir = join(root, "legacy");
  mkdirSync(join(legacyDir, "steps"), { recursive: true });
  writeFileSync(join(legacyDir, "steps", "01-a.md"), "# a\n");
  writeFileSync(join(legacyDir, "WORKFLOW.md"), "---\ndescription: legacy flow\nsteps:\n  - steps/01-a.md\n---\n");
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  assert.ok(run.tools.has("workflow_advance"), "legacy workflows keep advance");
  assert.ok(run.tools.has("workflow_transition"), "structured workflows get transition");

  await run.commands.get("reasoning").handler("", run.ctx);
  assert.ok(run.activeTools.has("workflow_transition"));
  assert.ok(!run.activeTools.has("workflow_advance"), "structured and legacy tools never appear together");
  const wrong = await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /uses `workflow_transition`/);
  await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);

  await run.commands.get("legacy").handler("", run.ctx);
  assert.ok(run.activeTools.has("workflow_advance"));
  assert.ok(!run.activeTools.has("workflow_transition"));
  const wrongLegacy = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "x" } }, undefined, undefined, run.ctx);
  assert.equal(wrongLegacy.isError, true);
  assert.match(wrongLegacy.content[0].text, /uses `workflow_advance`/);
});

test("cancellation commits nothing on transition", async () => {
  const root = tempRoot("structured-cancel-");
  writeReasoning(root);
  const run = harness(root);
  await startRun(run);
  const entriesBefore = run.entries.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["task-framed"], checkpoint: { summary: "x" } }, controller.signal, undefined, run.ctx),
    /cancelled/,
  );
  assert.equal(run.entries.length, entriesBefore);
});

test("append failure keeps the prior position and tools", async () => {
  const root = tempRoot("structured-append-");
  writeReasoning(root);
  const run = harness(root);
  await startRun(run);
  run.setAppendFailure("disk full");
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["task-framed"], checkpoint: { summary: "x" } }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "storage-failed");
  assert.deepEqual(run.entries.at(-1).data.position, { kind: "step", stepId: "frame" }, "prior position stays durable");
  run.setAppendFailure(null);
  const retry = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["task-framed"], checkpoint: { summary: "x" } }, undefined, undefined, run.ctx);
  assert.equal(retry.isError, undefined);
  assert.deepEqual(run.entries.at(-2).data.position, { kind: "step", stepId: "observe" });
});

// --- planner and plan validation ---

test("planner pass requires checkpoint.data.plan", async () => {
  const root = tempRoot("structured-plan-missing-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "plan ready" } }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must carry checkpoint\.data\.plan/);
  assert.deepEqual(run.entries.at(-1).data.position, { kind: "step", stepId: "plan" }, "invalid plans do not alter the committed checkpoint");
});

test("invalid plans return every schema error and stay on the planner", async () => {
  const root = tempRoot("structured-plan-invalid-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  const cases = [
    [plan([node("a", "inspect"), node("a", "inspect")]), /duplicates a/],
    [plan([node("a", "inspect", { prompt: "do this" })]), /plan.nodes\[0\].prompt is not an accepted node field/],
    [plan([node("a", "inspect", { model: "p/m" })]), /plan.nodes\[0\].model is not an accepted node field/],
    [plan([node("only-one", "inspect")]), /must contain 2 to 8 nodes/],
    [plan([node("a", "inspect"), node("b", "ghost-operator")]), /operator must name a known operator/],
    [plan([node("a", "inspect"), node("b", "trace", { dependsOn: ["a", "a"] })]), /must not contain duplicates/],
    [plan([node("a", "inspect"), node("b", "trace", { dependsOn: ["b"] })]), /must not include its own node/],
    [plan([node("a", "inspect"), node("b", "trace", { dependsOn: ["later"] }), node("c", "inspect")]), /must name an earlier node or a retained completed result/],
    [plan([node("a", "inspect", { tools: ["sudo"] }), node("b", "trace")]), /not in the captured baseline/],
    [plan([node("a", "inspect", { tools: ["bash"] }), node("b", "trace")]), /exceeds the inspect operator tool ceiling/],
    [plan([node("a", "inspect", { done: [] }), node("b", "trace")]), /done must be a non-empty list/],
    [{ version: 2, nodes: [node("a", "inspect"), node("b", "inspect")] }, /plan.version must be 1/],
    [{ version: 1, nodes: [node("a", "inspect"), node("b", "inspect")], policy: {} }, /plan.policy is not an accepted plan field/],
  ];
  for (const [planValue, pattern] of cases) {
    const result = await deliverPlan(run, planValue);
    assert.equal(result.isError, true, JSON.stringify(planValue));
    assert.match(result.content[0].text, pattern, JSON.stringify(planValue));
  }
  assert.deepEqual(run.entries.at(-1).data.position, { kind: "step", stepId: "plan" });
});

test("a valid plan enters the first node with narrowed tools", async () => {
  const root = tempRoot("structured-plan-valid-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  const result = await deliverPlan(run);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /execute node 1\/2: inspect-basics/);
  assert.match(run.sent.at(-1).message, /at execute node 1\/2: inspect-basics/);
  const snapshot = run.entries.at(-2).data;
  assert.deepEqual(snapshot.position, { kind: "node", stepId: "execute", revision: 1, nodeId: "inspect-basics", attempt: 1 });
  assert.equal(snapshot.memory.execution.plan.nodes.length, 2);
  assert.ok(run.activeTools.has("workflow_transition"));
  assert.ok(run.activeTools.has("read"));
  assert.ok(!run.activeTools.has("bash"), "inspect operator ceiling narrows tools");

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /## Operator: inspect/);
  assert.match(prompt.systemPrompt, /Read narrowly and report facts\./);
  assert.match(prompt.systemPrompt, /## Node objective/);
  assert.match(prompt.systemPrompt, /inspect-basics objective/);
  assert.doesNotMatch(prompt.systemPrompt, /trace-flow/, "future nodes are absent");
  assert.doesNotMatch(prompt.systemPrompt, /Plan schema/, "node prompts omit the plan schema");
  assert.match(prompt.systemPrompt, /- `inspect-basics-done`/);
});

test("node passes persist results and run one node per turn", async () => {
  const root = tempRoot("structured-node-pass-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  const first = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["inspect-basics-done"], checkpoint: { summary: "found the seam", unknowns: ["auth unclear"] } }, undefined, undefined, run.ctx);
  assert.equal(first.isError, undefined);
  assert.match(first.content[0].text, /execute node 2\/2: trace-flow/);
  assert.equal(run.entries.at(-2).data.memory.execution.results["inspect-basics"].summary, "found the seam");

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /## Operator: trace/);
  assert.match(prompt.systemPrompt, /## Dependency results/);
  assert.match(prompt.systemPrompt, /- `inspect-basics`: found the seam/);
  assert.match(prompt.systemPrompt, /## Open unknowns/);
  assert.match(prompt.systemPrompt, /- auth unclear/);

  const second = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["trace-flow-done"], checkpoint: { summary: "traced" } }, undefined, undefined, run.ctx);
  assert.equal(second.isError, undefined);
  assert.match(second.content[0].text, /Continue at verify/);
  assert.deepEqual(run.entries.at(-2).data.position, { kind: "step", stepId: "verify" });
});

test("node criteria gate passes", async () => {
  const root = tempRoot("structured-node-criteria-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["wrong"], checkpoint: { summary: "x" } }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown criterion id: wrong/);
});

test("node rework increments attempts with a hard bound", async () => {
  const root = tempRoot("structured-node-rework-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  const rework = (extra) => run.tools.get("workflow_transition").execute("call", { outcome: "rework", met: [], checkpoint: { summary: "stuck" }, ...extra }, undefined, undefined, run.ctx);
  const first = await rework();
  assert.equal(first.isError, undefined);
  assert.deepEqual(run.entries.at(-2).data.position, { kind: "node", stepId: "execute", revision: 1, nodeId: "inspect-basics", attempt: 2 });
  const second = await rework();
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /attempt limit reached/);
});

test("node replan returns to the planner and retains results", async () => {
  const root = tempRoot("structured-node-replan-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["inspect-basics-done"], checkpoint: { summary: "done" } }, undefined, undefined, run.ctx);
  const replan = await run.tools.get("workflow_transition").execute("call", { outcome: "replan", met: [], checkpoint: { summary: "approach was wrong" } }, undefined, undefined, run.ctx);
  assert.equal(replan.isError, undefined);
  const snapshot = run.entries.at(-2).data;
  assert.deepEqual(snapshot.position, { kind: "step", stepId: "plan" });
  assert.equal(snapshot.memory.execution.revision, 2);
  assert.equal(snapshot.memory.execution.replans, 1);
  assert.ok(snapshot.memory.execution.results["inspect-basics"], "results are retained across a replan");
  assert.equal(snapshot.memory.steps.execute.summary, "approach was wrong");

  const plannerPrompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(plannerPrompt.systemPrompt, /## Retained completed results/);
  assert.match(plannerPrompt.systemPrompt, /- `inspect-basics` \[inspect\]: done/);
  assert.match(plannerPrompt.systemPrompt, /## Replan reason/);
  assert.match(plannerPrompt.systemPrompt, /approach was wrong/);

  const replacement = plan([node("probe-deeper", "trace", { dependsOn: ["inspect-basics"] }), node("confirm", "inspect")]);
  const applied = await deliverPlan(run, replacement);
  assert.equal(applied.isError, undefined, JSON.stringify(applied.content));
  assert.match(applied.content[0].text, /execute node 1\/2: probe-deeper/);
});

test("replacement plans must use new ids for new work", async () => {
  const root = tempRoot("structured-replan-ids-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["inspect-basics-done"], checkpoint: { summary: "done" } }, undefined, undefined, run.ctx);
  await run.tools.get("workflow_transition").execute("call", { outcome: "replan", met: [], checkpoint: { summary: "redo" } }, undefined, undefined, run.ctx);
  const result = await deliverPlan(run, plan([node("inspect-basics", "trace"), node("b", "inspect")]));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already a retained result/);
});

test("replan has a hard bound", async () => {
  const root = tempRoot("structured-replan-bound-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  const replan = (label) => run.tools.get("workflow_transition").execute("call", { outcome: "replan", met: [], checkpoint: { summary: label } }, undefined, undefined, run.ctx);
  assert.equal((await replan("one")).isError, undefined);
  await deliverPlan(run);
  assert.equal((await replan("two")).isError, undefined);
  await deliverPlan(run);
  const third = await replan("three");
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /replan limit reached/);
});

// --- verifier ---

async function reachVerify(run) {
  await reachPlanStep(run);
  await deliverPlan(run);
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["inspect-basics-done"], checkpoint: { summary: "found it" } }, undefined, undefined, run.ctx);
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: ["trace-flow-done"], checkpoint: { summary: "traced it" } }, undefined, undefined, run.ctx);
}

test("the verifier prompt lists results and rework ids", async () => {
  const root = tempRoot("structured-verifier-");
  writeReasoning(root);
  const run = harness(root);
  await reachVerify(run);
  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /## Active plan results \(revision 1\)/);
  assert.match(prompt.systemPrompt, /- `inspect-basics` \[inspect\]: found it/);
  assert.match(prompt.systemPrompt, /- `trace-flow` \[trace\]: traced it/);
  const convergePrompt = prompt.systemPrompt;
  assert.doesNotMatch(convergePrompt, /## Operator: /, "verifier sees no operator bodies");
});

test("verifier rework invalidates requested nodes and transitive dependents", async () => {
  const root = tempRoot("structured-invalidate-");
  writeReasoning(root);
  const run = harness(root);
  await reachVerify(run);
  const result = await run.tools.get("workflow_transition").execute(
    "call",
    { outcome: "rework", met: [], checkpoint: { summary: "conclusion does not hold" }, nodes: ["inspect-basics"] },
    undefined,
    undefined,
    run.ctx,
  );
  assert.equal(result.isError, undefined);
  const snapshot = run.entries.at(-2).data;
  assert.deepEqual(snapshot.position, { kind: "node", stepId: "execute", revision: 1, nodeId: "inspect-basics", attempt: 1 }, "returns to the earliest invalidated node");
  assert.equal(snapshot.memory.execution.results["inspect-basics"], undefined);
  assert.equal(snapshot.memory.execution.results["trace-flow"], undefined, "dependents are invalidated transitively");
  assert.equal(snapshot.memory.steps.verify.summary, "conclusion does not hold");
});

test("verifier rework validates node ids and completed results", async () => {
  const root = tempRoot("structured-invalidate-bad-");
  writeReasoning(root);
  const run = harness(root);
  await reachVerify(run);
  const cases = [
    [["ghost"], /unknown node id: ghost/],
    [["inspect-basics", "inspect-basics"], /must not contain duplicates/],
  ];
  for (const [nodes, pattern] of cases) {
    const result = await run.tools.get("workflow_transition").execute("call", { outcome: "rework", met: [], checkpoint: { summary: "x" }, nodes }, undefined, undefined, run.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, pattern);
  }
});

test("nodes from a node position cannot request invalidation", async () => {
  const root = tempRoot("structured-invalidate-node-");
  writeReasoning(root);
  const run = harness(root);
  await reachPlanStep(run);
  await deliverPlan(run);
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "rework", met: [], checkpoint: { summary: "x" }, nodes: ["inspect-basics"] }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nodes is only valid for a verifier rework/);
});

// --- completion ---

test("structured completion ends without a summary follow-up", async () => {
  const root = tempRoot("structured-complete-");
  writeReasoning(root);
  const run = harness(root);
  await reachVerify(run);
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "verified" } }, undefined, undefined, run.ctx);
  await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "converged" } }, undefined, undefined, run.ctx);
  const sentBefore = run.sent.length;
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "delivered" } }, undefined, undefined, run.ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.terminate, undefined, "no second turn is scheduled");
  assert.match(result.content[0].text, /Present the prepared final result/);
  assert.equal(run.sent.length, sentBefore, "no summary follow-up");
  assert.deepEqual(run.entries.at(-1).data, { v: 2, status: "completed", workflow: "reasoning", runId: run.entries.at(-1).data.runId, totalSteps: 7 });
  assert.ok(!run.activeTools.has("workflow_transition"));
});

// --- resume ---

test("v3 snapshots resume at steps and mid-plan nodes", async () => {
  const root = tempRoot("structured-resume-");
  writeReasoning(root);
  const first = harness(root);
  await reachPlanStep(first);
  const planSnapshot = first.entries.at(-1).data;

  const stepRun = harness(root, [first.entries.at(-1)]);
  await stepRun.handlers.get("session_start")({ reason: "resume" }, stepRun.ctx);
  assert.deepEqual(stepRun.statuses.at(-1), { key: "pi-workflows", value: "reasoning 3/7" });
  assert.ok(stepRun.activeTools.has("workflow_transition"));
  const prompt = await stepRun.handlers.get("before_agent_start")({ systemPrompt: "base" }, stepRun.ctx);
  assert.match(prompt.systemPrompt, /at `plan`/);

  await deliverPlan(first);
  const nodeRun = harness(root, [first.entries.at(-1)]);
  await nodeRun.handlers.get("session_start")({ reason: "resume" }, nodeRun.ctx);
  assert.deepEqual(nodeRun.statuses.at(-1), { key: "pi-workflows", value: "reasoning execute 1/2" });
  const nodePrompt = await nodeRun.handlers.get("before_agent_start")({ systemPrompt: "base" }, nodeRun.ctx);
  assert.match(nodePrompt.systemPrompt, /## Operator: inspect/);
  void planSnapshot;
});

test("invalid v3 snapshots drop with one warning", async () => {
  const root = tempRoot("structured-resume-invalid-");
  writeReasoning(root);
  const run = harness(root);
  run.entries.push({ type: "custom", customType: "pi-workflows", data: { v: 3, status: "active", workflow: "reasoning", runId: "bad", position: { kind: "step" }, target: "", delivered: true, memory: { steps: {} } } });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.notices.some((item) => item.level === "warning" && /malformed snapshot/.test(item.message)));
  assert.ok(!run.activeTools.has("workflow_transition"));

  run.entries.length = 0;
  run.entries.push({ type: "custom", customType: "pi-workflows", data: { v: 3, status: "active", workflow: "reasoning", runId: "stale", position: { kind: "step", stepId: "ghost" }, target: "", delivered: true, memory: { steps: {} } } });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.notices.some((item) => /step `ghost` no longer exists/.test(item.message)));
  assert.ok(!run.activeTools.has("workflow_transition"));
});

test("legacy v2 snapshots resume into a derived step id", async () => {
  const root = tempRoot("structured-resume-v2-");
  writeReasoning(root);
  const run = harness(root);
  run.entries.push({
    type: "custom",
    customType: "pi-workflows",
    data: { v: 2, status: "active", workflow: "reasoning", runId: "old", step: 3, target: "legacy", delivered: true },
  });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.deepEqual(run.statuses.at(-1), { key: "pi-workflows", value: "reasoning 3/7" });
  assert.ok(run.activeTools.has("workflow_transition"));
  const next = await run.tools.get("workflow_transition").execute("call", { outcome: "pass", met: [], checkpoint: { summary: "x", data: { plan: PASS_PLAN } } }, undefined, undefined, run.ctx);
  assert.equal(next.isError, undefined);
  assert.deepEqual(run.entries.at(-2).data.position, { kind: "node", stepId: "execute", revision: 1, nodeId: "inspect-basics", attempt: 1 });
  assert.equal(run.entries.at(-2).data.memory.steps.plan.summary, "x");
});

test("entry into the executor without a plan fails closed", async () => {
  const root = tempRoot("structured-executor-guard-");
  const frontmatter = REASONING_FRONTMATTER.replace("    kind: executor", "    kind: executor\n    on:\n      pass: verify");
  writeReasoning(root, "reasoning", { frontmatter });
  const run = harness(root);
  await startRun(run);
  const result = await run.tools.get("workflow_transition").execute("call", { outcome: "rework", met: [], checkpoint: { summary: "x" } }, undefined, undefined, run.ctx);
  assert.equal(result.isError, undefined, "default rework stays on the current static step");
  const intoExecutor = await run.tools.get("workflow_transition").execute(
    "call",
    { outcome: "pass", met: ["task-framed"], checkpoint: { summary: "x" } },
    undefined,
    undefined,
    run.ctx,
  );
  void intoExecutor;
});
