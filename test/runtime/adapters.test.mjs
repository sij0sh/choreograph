import test from "node:test";
import assert from "node:assert/strict";
import { effectiveTools, CONTROL_TOOLS } from "../../src/runtime/capabilities.ts";
import { statusValue } from "../../src/runtime/status.ts";
import { renderPrompt, rosterPrompt } from "../../src/runtime/prompts.ts";
import { completed, cp, sequence, task, workflow } from "../engine/helpers.mjs";
import { start, transition } from "../../src/engine/interpreter.ts";

const BASE = ["read", "bash", "edit"];

function toolsFor(wf, state, baseline = BASE) {
  return effectiveTools(wf, state, baseline);
}

test("capabilities intersect workflow and task ceilings with the baseline", () => {
  const wf = workflow([task("a", { tools: ["read"] }), task("b")], { tools: ["read", "bash"] });
  let state = start(wf, { runId: "r1" }).state;
  assert.deepEqual(toolsFor(wf, state), ["read", ...CONTROL_TOOLS]);
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("a")) }).state;
  assert.deepEqual(toolsFor(wf, state), ["read", "bash", ...CONTROL_TOOLS]);
});

test("an empty workflow ceiling removes all baseline tools", () => {
  const wf = workflow([task("a")], { tools: [] });
  const state = start(wf, { runId: "r1" }).state;
  assert.deepEqual(toolsFor(wf, state), [...CONTROL_TOOLS]);
});

test("operator ceilings narrow node positions", () => {
  const OPERATORS = new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect.", tools: ["read"] }],
    ["trace", { id: "trace", path: "operators/trace.md", description: "Trace." }],
  ]);
  const wf = workflow([task("frame"), { kind: "plan", id: "p", operators: ["inspect", "trace"] }], { operators: OPERATORS });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed")) }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", { plan: { version: 1, nodes: [
      { id: "a", operator: "inspect", objective: "o", done: ["a-done"] },
      { id: "b", operator: "trace", objective: "o", done: ["b-done"] },
    ] } })),
  }).state;
  assert.deepEqual(toolsFor(wf, state), ["read", ...CONTROL_TOOLS], "the inspect operator narrows to read");
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["a-done"], checkpoint: cp("a") } }).state;
  assert.deepEqual(toolsFor(wf, state), ["read", "bash", "edit", ...CONTROL_TOOLS], "the trace operator has no ceiling");
});

test("status renders the workflow name and position path", () => {
  const wf = workflow([task("a"), sequence("s", [task("b")])]);
  let state = start(wf, { runId: "r1" }).state;
  assert.equal(statusValue(wf, state), "demo: a");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("a")) }).state;
  assert.equal(statusValue(wf, state), "demo: s/b");
});

function reader(files) {
  return (path) => files[path] ?? fail(`missing ${path}`);
  function fail(message) {
    throw new Error(message);
  }
}

test("the task prompt carries instructions, context, criteria, and controls", () => {
  const wf = workflow([task("frame", { done: ["scope-clear"] })]);
  const state = start(wf, { runId: "run-1", target: "runtime" }).state;
  const prompt = renderPrompt(wf, state, reader({ "WORKFLOW.md": "# Overview\nDo the thing.", "steps/frame.md": "---\nfrontmatter\n---\n# Frame\nFrame it." }));
  assert.match(prompt, /run-1/);
  assert.match(prompt, /Target: runtime/);
  assert.match(prompt, /# Frame/);
  assert.ok(!prompt.includes("frontmatter"), "frontmatter is stripped");
  assert.match(prompt, /scope-clear/);
  assert.match(prompt, /workflow_transition/);
});

test("the plan-create prompt lists operator descriptions but never bodies", () => {
  const OPERATORS = new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ]);
  const wf = workflow([{ kind: "plan", id: "p", operators: ["inspect"] }], { operators: OPERATORS });
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPrompt(wf, state, reader({ "WORKFLOW.md": "# Overview", "operators/inspect.md": "# Secret operator body" }));
  assert.match(prompt, /`inspect`: Inspect code\./);
  assert.ok(!prompt.includes("Secret operator body"), "planners see descriptions only");
  assert.match(prompt, /checkpoint\.data\.plan/);
});

test("the node prompt shows the operator body but not other operators", () => {
  const OPERATORS = new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
    ["trace", { id: "trace", path: "operators/trace.md", description: "Trace flow." }],
  ]);
  const wf = workflow([{ kind: "plan", id: "p", operators: ["inspect", "trace"] }], { operators: OPERATORS });
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, {
    type: "outcome",
    outcome: completed(cp("planned", { plan: { version: 1, nodes: [
      { id: "probe", operator: "inspect", objective: "Find the entrypoint.", done: ["probe-done"] },
      { id: "flow", operator: "trace", objective: "Trace it.", done: ["flow-done"], dependsOn: ["probe"] },
    ] } })),
  }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "completed", met: ["probe-done"], checkpoint: cp("found entry", { entry: "main.ts" }) } }).state;
  const prompt = renderPrompt(wf, state, reader({
    "WORKFLOW.md": "# Overview",
    "operators/inspect.md": "# Inspect\nRead the code.",
    "operators/trace.md": "# Trace\nFollow the flow.",
  }));
  assert.match(prompt, /# Trace/);
  assert.ok(!prompt.includes("Read the code"), "other operator bodies stay hidden");
  assert.match(prompt, /`probe`: found entry/, "dependency results appear");
  assert.match(prompt, /Trace it\./);
});

test("the roster prompt lists only visible workflows", () => {
  const visible = workflow([task("a")], { name: "review", description: "Review things.", piVisibility: true });
  const hidden = workflow([task("b")], { name: "secret", piVisibility: false });
  const roster = rosterPrompt([visible, hidden].filter((wf) => wf.piVisibility));
  assert.match(roster, /`review`: Review things\./);
  assert.ok(!roster.includes("secret"));
  assert.equal(rosterPrompt([]), "");
});

test("prior checkpoint context follows execution order, not key spelling", () => {
  const files = { "WORKFLOW.md": "# Overview", "steps/zeta.md": "# Z", "steps/alpha.md": "# A" };
  const reader = (path) => {
    if (!(path in files)) throw new Error(`missing ${path}`);
    return files[path];
  };
  const wf = workflow([task("zeta"), task("alpha")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("ZETA-SUMMARY")) }).state;
  const prompt = renderPrompt(wf, state, reader);
  assert.ok(prompt.includes("ZETA-SUMMARY"), "a checkpoint written before the current position renders regardless of spelling");
});
