import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_WORKFLOW_UI_MODE,
  buildWorkflowView,
  nextWorkflowUiMode,
  parseWorkflowUiMode,
  renderWorkflow,
  workflowUiModeFromEnv,
} from "../../src/runtime/workflow-ui.ts";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { blocked, completed, cp, loop, needsWork, sequence, task, workflow } from "../engine/helpers.mjs";

// Keyed outcomes (corr-c1): inject the current leaf key like the engine tests do.
const t = (wf, state, outcome) =>
  engineTransition(wf, state, { type: "outcome", outcome: { key: state.stack.at(-1)?.key, ...outcome } }).state;

function viewOf(wf, outcomes) {
  let state = start(wf, { runId: "r1" }).state;
  for (const outcome of outcomes) state = t(wf, state, outcome);
  return { state, view: buildWorkflowView(wf, state) };
}

test("mode parsing rejects invalid values and the env helper falls back", () => {
  assert.equal(parseWorkflowUiMode("detailed"), "detailed");
  assert.equal(parseWorkflowUiMode("  OFF "), "off");
  assert.equal(parseWorkflowUiMode("minimal"), undefined);
  assert.equal(parseWorkflowUiMode(undefined), undefined);
  assert.equal(workflowUiModeFromEnv(undefined), DEFAULT_WORKFLOW_UI_MODE);
  assert.equal(workflowUiModeFromEnv("bogus"), DEFAULT_WORKFLOW_UI_MODE);
  assert.equal(workflowUiModeFromEnv("off"), "off");
});

test("cycling walks off -> compact -> detailed -> off", () => {
  assert.equal(nextWorkflowUiMode("off"), "compact");
  assert.equal(nextWorkflowUiMode("compact"), "detailed");
  assert.equal(nextWorkflowUiMode("detailed"), "off");
});

test("root task phases run complete -> active -> pending", () => {
  const wf = workflow([task("frame", { done: ["framed"] }), task("author"), task("deliver")]);
  const { view } = viewOf(wf, [completed(cp("framed"), ["framed"])]);
  assert.deepEqual(
    view.phases.map((phase) => phase.state),
    ["complete", "active", "pending"],
  );
  assert.equal(view.state, "running");
  assert.deepEqual(view.current, { path: "author", runner: "agent", attempt: 1 });
  assert.equal(view.attention, undefined);
});

test("nested sequences name the full relative path", () => {
  const wf = workflow([task("frame"), sequence("group", [task("a"), task("b")])]);
  const { view } = viewOf(wf, [completed(cp("framed"))]);
  assert.equal(view.current.path, "group/a");
  assert.deepEqual(
    view.phases.map((phase) => phase.label),
    ["frame", "group"],
  );
});

test("a false top-level guard marks the phase skipped", () => {
  const wf = workflow([
    task("frame"),
    { ...task("deep"), guard: { from: "frame", op: "equals", value: "high", select: "/data/severity" } },
    task("deliver"),
  ]);
  const { view } = viewOf(wf, [completed(cp("framed", { severity: "low" }))]);
  assert.deepEqual(
    view.phases.map((phase) => phase.state),
    ["complete", "skipped", "active"],
  );
});

test("an active loop reports iteration, total, and phase progress", () => {
  const wf = workflow([task("gather"), loop("review", { bodyId: "review-one", maxIterations: 8 }), task("deliver")]);
  const { view } = viewOf(wf, [completed(cp("listed", { files: ["a", "b"] }))]);
  assert.deepEqual(view.current.loop, { iteration: 1, total: 2 });
  assert.equal(view.phases[1].progress, "1/2");
  assert.equal(view.current.path, "review/loop[1]/review-one");
});

test("a plan first shows creation, then node progress and result summaries", () => {
  const operators = new Map([["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect." }]]);
  const wf = workflow([task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }], { operators });
  const plan = {
    version: 1,
    nodes: [
      { id: "probe", operator: "inspect", objective: "Find it.", done: ["probe-done"] },
      { id: "trace", operator: "inspect", objective: "Trace it.", dependsOn: ["probe"], done: ["trace-done"] },
    ],
  };
  const { view: creating } = viewOf(wf, [completed(cp("planned", { plan }))]);
  assert.equal(creating.current.path, "investigate");
  assert.equal(creating.current.plan, undefined);

  let state = start(wf, { runId: "r1" }).state;
  state = t(wf, state, completed(cp("framed")));
  state = t(wf, state, completed(cp("planned", { plan })));
  const executing = buildWorkflowView(wf, state);
  assert.equal(executing.current.path, "investigate/probe");
  assert.deepEqual(executing.current.plan, { completed: 0, total: 2 });
  assert.equal(executing.phases[1].progress, "0/2");

  state = t(wf, state, { status: "completed", met: ["probe-done"], checkpoint: cp("probed the api", { risk: "low" }) });
  const afterProbe = buildWorkflowView(wf, state);
  assert.deepEqual(afterProbe.current.plan, { completed: 1, total: 2 });
  assert.equal(afterProbe.current.path, "investigate/trace");

  state = t(wf, state, { status: "completed", met: ["trace-done"], checkpoint: cp("traced the calls") });
  assert.equal(state.status, "completed", "the workflow completed");
  assert.equal(buildWorkflowView(wf, state), undefined, "completed runs expose no view");
});

test("a plan node result summary appears in done even though it leaves no checkpoint", () => {
  const operators = new Map([["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect." }]]);
  const wf = workflow(
    [task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }, task("deliver")],
    { operators },
  );
  const plan = {
    version: 1,
    nodes: [
      { id: "probe", operator: "inspect", objective: "Find it.", done: ["probe-done"] },
      { id: "trace", operator: "inspect", objective: "Trace it.", dependsOn: ["probe"], done: ["trace-done"] },
    ],
  };
  const { view } = viewOf(wf, [
    completed(cp("framed")),
    completed(cp("planned", { plan })),
    { status: "completed", met: ["probe-done"], checkpoint: cp("probed the api") },
  ]);
  const labels = view.completed.map((item) => item.label);
  assert.deepEqual(labels, ["frame", "investigate", "investigate/probe"], "the plan-creation checkpoint counts as done");
  assert.equal(view.completed[2].summary, "probed the api");
  assert.deepEqual(view.current.plan, { completed: 1, total: 2 });
});

test("a needs-work retry shows the attempt and the failure as attention", () => {
  const wf = workflow([task("frame"), task("deliver")]);
  const { state, view } = viewOf(wf, [needsWork(cp("tests exited 1"))]);
  assert.equal(view.current.attempt, 2);
  assert.equal(view.attention, "tests exited 1");
  assert.equal(view.state, "running");
  assert.equal(view.completed.length, 0, "the current failure is not done");
  assert.equal(state.checkpoints["root/frame"].summary, "tests exited 1");
});

test("a parked run reports waiting with the parked checkpoint as attention", () => {
  const wf = workflow([task("frame"), task("deliver")]);
  const { view } = viewOf(wf, [blocked(cp("waiting on operator"))]);
  assert.equal(view.state, "waiting");
  assert.equal(view.attention, "waiting on operator");
  assert.equal(view.completed.length, 0, "the waiting checkpoint is excluded from done");
  const lines = renderWorkflow(view, "compact", 80);
  assert.match(lines[2], /^\[!\] frame: waiting on operator$/, "parked attention replaces the now-line");
});

test("completed summaries come from checkpoints in order", () => {
  const wf = workflow([task("frame", { done: ["framed"] }), task("author", { done: ["authored"] }), task("deliver")]);
  const { view } = viewOf(wf, [completed(cp("framed the data"), ["framed"]), completed(cp("package written"), ["authored"])]);
  assert.deepEqual(view.completed, [
    { label: "frame", summary: "framed the data" },
    { label: "author", summary: "package written" },
  ]);
});

test("long workflows render a moving window around the active phase", () => {
  const wf = workflow(Array.from({ length: 8 }, (_, index) => task(`step${index}`)));
  const { view } = viewOf(wf, Array.from({ length: 4 }, (_, index) => completed(cp(`did ${index}`))));
  const lines = renderWorkflow(view, "compact", 50);
  const phaseLine = lines[1];
  assert.match(phaseLine, /\.\.\./, "the window elides distant phases");
  assert.match(phaseLine, /\[>\] step4/, "the active phase stays visible");
  assert.ok(!phaseLine.includes("step0"), "phases far behind the window disappear");
});

test("long summaries clip on code-point boundaries", () => {
  const wf = workflow([task("frame"), task("deliver")]);
  const long = `x`.repeat(200);
  const { view } = viewOf(wf, [completed(cp(long))]);
  assert.ok(view.completed[0].summary.length < 200);
  assert.ok(view.completed[0].summary.endsWith("..."));
  const unicode = "\u00e9".repeat(120);
  const unicodeView = buildWorkflowView(
    wf,
    (() => {
      let state = start(wf, { runId: "r2" }).state;
      return t(wf, state, completed(cp(unicode)));
    })(),
  );
  assert.ok(!unicodeView.completed[0].summary.includes("\ufffd"), "no broken code points");
});

test("compact, detailed, and inspect render the same view within width", () => {
  const operators = new Map([["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect." }]]);
  const wf = workflow(
    [task("frame"), { kind: "plan", id: "investigate", operators: ["inspect"] }, task("deliver")],
    { operators },
  );
  const plan = {
    version: 1,
    nodes: [
      { id: "probe", operator: "inspect", objective: "Find it.", done: ["probe-done"] },
      { id: "trace", operator: "inspect", objective: "Trace it.", dependsOn: ["probe"], done: ["trace-done"] },
    ],
  };
  const { view } = viewOf(wf, [
    completed(cp("framed the data", { severity: "high" })),
    completed(cp("planned", { plan })),
    needsWork(cp("tests exited 1 with a very long failure reason that must clip somewhere reasonable")),
  ]);
  for (const verbosity of ["compact", "detailed", "inspect"]) {
    for (const width of [120, 80, 50, 30, 16]) {
      for (const line of renderWorkflow(view, verbosity, width)) {
        assert.ok(visibleWidth(line) <= width, `${verbosity} at ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
  const detailed = renderWorkflow(view, "detailed", 80);
  assert.match(detailed[0], /Demo/);
  assert.ok(detailed.some((line) => line.startsWith("attention ")));
  assert.ok(detailed.filter((line) => line.startsWith("done ")).length <= 3, "detailed keeps at most three done lines");
  const inspect = renderWorkflow(view, "inspect", 60);
  assert.ok(inspect.some((line) => line === "PROGRESS"));
  assert.ok(inspect.some((line) => line === "NOW"));
  assert.ok(inspect.some((line) => line === "DONE"));
  assert.ok(inspect.some((line) => line === "ATTENTION"));
  assert.ok(inspect.some((line) => line === "esc closes"));
});

test("a palette colors rendered output without breaking width bounds", () => {
  const palette = {
    heading: (text) => `\u001b[36m${text}\u001b[0m`,
    muted: (text) => `\u001b[2m${text}\u001b[0m`,
    accent: (text) => `\u001b[36m${text}\u001b[0m`,
    success: (text) => `\u001b[32m${text}\u001b[0m`,
    warning: (text) => `\u001b[33m${text}\u001b[0m`,
    error: (text) => `\u001b[31m${text}\u001b[0m`,
  };
  const wf = workflow([task("frame"), task("deliver")]);
  const { view } = viewOf(wf, [completed(cp("framed"))]);
  for (const line of renderWorkflow(view, "detailed", 40, palette)) {
    assert.ok(visibleWidth(line) <= 40, JSON.stringify(line));
  }
  assert.match(renderWorkflow(view, "compact", 80, palette)[0], /\u001b\[36mDemo\u001b\[0m/);
});
