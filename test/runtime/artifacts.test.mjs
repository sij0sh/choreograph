import test from "node:test";
import assert from "node:assert/strict";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";
import { resolveBinding } from "../../src/runtime/artifacts.ts";
import { inputSection } from "../../src/runtime/prompts-inputs.ts";
import { renderPrompt } from "../../src/runtime/prompts.ts";

const operators = (output) =>
  new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect.", ...(output ? { output } : {}) }],
  ]);

function reader(files) {
  return (path) => {
    if (!(path in files)) throw new Error(`missing ${path}`);
    return files[path];
  };
}

const PLAN = { version: 1, nodes: [
  { id: "probe", operator: "inspect", objective: "Find the entrypoint.", done: ["probe-done"] },
  { id: "flow", operator: "inspect", objective: "Trace it.", done: ["flow-done"], dependsOn: ["probe"] },
] };

function planOf(nodes = PLAN.nodes) {
  return completed(cp("planned", { plan: { version: 1, nodes } }));
}

test("bindings resolve from tasks, plan aggregates, and pointer selections", () => {
  const wf = workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }, task("deliver")], {
    operators: operators(),
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { objective: "review" })) }).state;
  state = transition(wf, state, { type: "outcome", outcome: planOf() }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["probe-done"], checkpoint: cp("found entry", { entry: "main.ts" }) },
  }).state;

  const taskBinding = resolveBinding(wf, state, { from: "frame" });
  assert.equal(taskBinding.ok, true);
  assert.deepEqual(taskBinding.value, { summary: "framed", data: { objective: "review" } });

  const selected = resolveBinding(wf, state, { from: "frame", select: "/data/objective" });
  assert.equal(selected.ok, true);
  assert.equal(selected.value, "review");

  const planBinding = resolveBinding(wf, state, { from: "investigate" });
  assert.equal(planBinding.ok, true);
  assert.deepEqual(planBinding.value.nodes.map((node) => node.id), ["probe", "flow"]);
  assert.equal(planBinding.value.nodes[0].result.data.entry, "main.ts");
  assert.equal(planBinding.value.nodes[1].result, null);

  const planSelected = resolveBinding(wf, state, { from: "investigate", select: "/nodes/0/result/data/entry" });
  assert.equal(planSelected.ok, true);
  assert.equal(planSelected.value, "main.ts");
});

test("bindings report actionable errors", () => {
  const wf = workflow([task("frame"), task("deliver")]);
  const state = start(wf, { runId: "r1" }).state;
  const missing = resolveBinding(wf, state, { from: "deliver" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no recorded checkpoint/);

  const unknown = resolveBinding(wf, state, { from: "ghost" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /not a step/);

  const incomplete = workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }], {
    operators: operators(),
  });
  let planState = start(incomplete, { runId: "r1" }).state;
  planState = transition(incomplete, planState, { type: "outcome", outcome: completed(cp("framed")) }).state;
  const early = resolveBinding(incomplete, planState, { from: "investigate" });
  assert.equal(early.ok, false);
  assert.match(early.error, /has not produced a plan yet/);

  planState = transition(incomplete, planState, { type: "outcome", outcome: planOf() }).state;
  const badPointer = resolveBinding(incomplete, planState, { from: "investigate", select: "/nodes/9" });
  assert.equal(badPointer.ok, false);
  assert.match(badPointer.error, /out of bounds/);
});

test("the input section renders declared inputs within the budget", () => {
  const wf = workflow([task("frame"), task("deliver", { inputs: { contract: { from: "frame" } } })]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { objective: "review" })) }).state;
  const section = inputSection(wf, state, { contract: { from: "frame" } });
  assert.match(section, /## Inputs/);
  assert.match(section, /\{"data":\{"objective":"review"\},"summary":"framed"\}/);
  assert.equal(inputSection(wf, state, undefined), "");

  const huge = workflow([task("frame"), task("deliver", {
    inputs: { first: { from: "frame", select: "/data/blob" }, second: { from: "frame", select: "/data/blob" }, third: { from: "frame", select: "/data/blob" } },
  })]);
  let hugeState = start(huge, { runId: "r1" }).state;
  hugeState = transition(huge, hugeState, {
    type: "outcome",
    outcome: completed(cp("big", { blob: "x".repeat(10_000) })),
  }).state;
  const oversized = inputSection(huge, hugeState, {
    first: { from: "frame", select: "/data/blob" },
    second: { from: "frame", select: "/data/blob" },
    third: { from: "frame", select: "/data/blob" },
  });
  assert.match(oversized, /`first` from `frame`: input exceeds the position input budget/);
  assert.match(oversized, /`second` from `frame`:/, "in-budget inputs still render");
});

test("plan-create prompts gain the overview and declared inputs", () => {
  const wf = workflow([{ kind: "plan", id: "investigate", operators: ["inspect"], inputs: { prior: { from: "frame" } } }, task("frame")], {
    operators: operators(),
  });
  const ordered = workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"], inputs: { prior: { from: "frame" } } }], {
    operators: operators(),
  });
  let state = start(ordered, { runId: "r1" }).state;
  state = transition(ordered, state, { type: "outcome", outcome: completed(cp("framed", { objective: "review" })) }).state;
  const prompt = renderPrompt(ordered, state, reader({
    "WORKFLOW.md": "# Overview\nInvariant: cite evidence.",
    "operators/inspect.md": "# Inspect",
  }));
  assert.match(prompt, /# Overview/);
  assert.match(prompt, /Invariant: cite evidence/);
  assert.match(prompt, /## Inputs/);
  assert.match(prompt, /\{"data":\{"objective":"review"\},"summary":"framed"\}/);
  assert.ok(!prompt.includes("Secret operator body"));
});

test("node prompts render full data for contract-bearing dependencies", () => {
  const wf = workflow([{ kind: "plan", id: "p", operators: ["inspect"] }], {
    operators: operators("finding"),
    contracts: { finding: { type: "object" } },
  });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: planOf() }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: { status: "completed", met: ["probe-done"], checkpoint: cp("found entry", { entry: "main.ts" }) },
  }).state;
  const prompt = renderPrompt(wf, state, reader({
    "WORKFLOW.md": "# Overview",
    "operators/inspect.md": "# Inspect\nRead the code.",
  }));
  assert.match(prompt, /contract `finding`/);
  assert.match(prompt, /\{"entry":"main\.ts"\}/);
  assert.match(prompt, /`probe` \[inspect, contract `finding`\]: found entry/);
});

test("prompts stay unchanged for workflows without bindings", () => {
  const wf = workflow([task("frame")]);
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPrompt(wf, state, reader({ "WORKFLOW.md": "# Overview", "steps/frame.md": "# Frame" }));
  assert.ok(!prompt.includes("## Inputs"), "no inputs section without bindings");
  assert.match(prompt, /# Frame/);
});
