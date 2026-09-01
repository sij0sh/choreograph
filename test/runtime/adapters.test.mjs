import test from "node:test";
import assert from "node:assert/strict";
import { effectiveTools, CONTROL_TOOLS } from "../../src/runtime/capabilities.ts";
import { readBlockFrom, renderPositionEnvelope, renderReportEnvelope, rosterPrompt, controlMessage } from "../../src/runtime/prompts.ts";
import { completed, cp, loop, sequence, task, workflow } from "../engine/helpers.mjs";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


const BASE = ["read", "bash", "edit"];

/** An in-memory fs for readBlockFrom: stat-first sizes from content, throws like node on misses. */
function memFs(files, hooks = {}) {
  const miss = (path) => Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: "ENOENT" });
  return {
    statSync: (path) => {
      if (hooks.stat) return hooks.stat(path);
      if (!(path in files)) throw miss(path);
      return { size: Buffer.byteLength(files[path], "utf8") };
    },
    readFileSync: (path) => {
      if (hooks.read) return hooks.read(path);
      if (!(path in files)) throw miss(path);
      return files[path];
    },
  };
}

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

function reader(files) {
  return (path) => files[path] ?? fail(`missing ${path}`);
  function fail(message) {
    throw new Error(message);
  }
}

test("the task prompt carries instructions, context, criteria, and controls", () => {
  const wf = workflow([task("frame", { done: ["scope-clear"] })]);
  const state = start(wf, { runId: "run-1", target: "runtime" }).state;
  const prompt = renderPositionEnvelope(wf, state, reader({ "WORKFLOW.md": "# Overview\nDo the thing.", "steps/frame.md": "---\nignored: frontmatter\n---\n# Frame\nFrame it." }));
  assert.match(prompt, /run-1/);
  assert.match(prompt, /Target: runtime/);
  assert.match(prompt, /# Frame/);
  assert.ok(!prompt.includes("frontmatter"), "frontmatter is stripped");
  assert.match(prompt, /scope-clear/);
  assert.match(prompt, /workflow_transition/);
});

test("the prompt states the tools granted at the position", () => {
  const wf = workflow([task("frame")]);
  const state = start(wf, { runId: "r1" }).state;
  const files = { "WORKFLOW.md": "# Overview", "steps/frame.md": "# Frame" };
  const read = reader(files);
  const narrowed = renderPositionEnvelope(wf, state, read, undefined, ["read", "workflow_transition", "workflow_abort", "workflow_retry"]);
  assert.match(narrowed, /Tools granted at this position: `read`\./);
  assert.ok(!narrowed.includes("`bash`"), "ungranted tools are not listed as granted");
  assert.ok(!narrowed.includes("workflow_retry"), "workflow controls are not reported as file tools");
  assert.match(narrowed, /Tools not listed are unavailable/);
  const wide = renderPositionEnvelope(wf, state, read, undefined, ["read", "bash", "workflow_transition", "workflow_abort"]);
  assert.match(wide, /Tools granted at this position: `read`, `bash`\./);
  assert.match(wide, /Use bash \(`ls`, `find`, `rg`\) to discover files/);
  const unlisted = renderPositionEnvelope(wf, state, read, undefined, []);
  assert.match(unlisted, /Tools granted at this position: none beyond the workflow controls above\./);
  const omitted = renderPositionEnvelope(wf, state, read);
  assert.ok(!omitted.includes("## Tools"), "omitting the tool list omits the section");
});

test("the plan-create prompt lists operator descriptions but never bodies", () => {
  const OPERATORS = new Map([
    ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ]);
  const wf = workflow([{ kind: "plan", id: "p", operators: ["inspect"] }], { operators: OPERATORS });
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPositionEnvelope(wf, state, reader({ "WORKFLOW.md": "# Overview", "operators/inspect.md": "# Secret operator body" }));
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
  const prompt = renderPositionEnvelope(wf, state, reader({
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
  const prompt = renderPositionEnvelope(wf, state, reader);
  assert.ok(prompt.includes("ZETA-SUMMARY"), "a checkpoint written before the current position renders regardless of spelling");
});

test("rule-led bodies render verbatim while real frontmatter still strips", () => {
  const files = { "WORKFLOW.md": "# Overview", "steps/frame.md": "---\n## Real work\ninstructions here\n---\nAfter the rule" };
  const reader = (path) => {
    if (!(path in files)) throw new Error(`missing ${path}`);
    return files[path];
  };
  const wf = workflow([task("frame")]);
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPositionEnvelope(wf, state, reader);
  assert.ok(prompt.includes("## Real work"), "a horizontal-rule-led body renders in full");
  assert.ok(prompt.includes("instructions here"));
  assert.ok(prompt.includes("After the rule"));

  const frontmatterFile = { ...files, "steps/frame.md": "---\ndescription: fm\n---\n# Body" };
  const fmReader = (path) => {
    if (!(path in frontmatterFile)) throw new Error(`missing ${path}`);
    return frontmatterFile[path];
  };
  const stripped = renderPositionEnvelope(wf, state, fmReader);
  assert.ok(!stripped.includes("description: fm"), "a real frontmatter mapping still strips");
  assert.ok(stripped.includes("# Body"));
});

test("runtime instruction reads enforce the authoring size cap", () => {
  const grown = { "WORKFLOW.md": "# Overview", "steps/frame.md": "# " + "x".repeat(200_000) };
  const grownRead = readBlockFrom(memFs(grown));
  const wf = workflow([task("frame")]);
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPositionEnvelope(wf, state, grownRead);
  assert.ok(prompt.includes("exceeds 128000 bytes"), "an oversized body yields actionable guidance instead of its content");
  assert.ok(!prompt.includes("xxx"), "the oversized content never renders");

  const normal = { "WORKFLOW.md": "# Overview", "steps/frame.md": "# Fine" };
  const normalRead = readBlockFrom(memFs(normal));
  const okPrompt = renderPositionEnvelope(wf, state, normalRead);
  assert.ok(okPrompt.includes("# Fine"), "in-bound bodies still render");
});

test("an at-rest over-bound file is rejected from its stat size without a full read (fx1)", () => {
  let reads = 0;
  const read = readBlockFrom(memFs({}, {
    stat: () => ({ size: 512 * 1024 * 1024 }),
    read: () => {
      reads += 1;
      return "# never reached";
    },
  }));
  assert.equal(
    read("steps/frame.md", "Task instructions"),
    "Task instructions exceeds 128000 bytes; restore or edit the file, or abort the run.",
    "rejection text is frozen: agents parse it",
  );
  assert.equal(reads, 0, "readFileSync must not run for a stat-over-bound file");
});

test("a file that grows between stat and read is still rejected by the post-read check (fx1)", () => {
  const read = readBlockFrom(memFs({}, {
    stat: () => ({ size: 10 }),
    read: () => "# " + "x".repeat(200_000),
  }));
  assert.equal(
    read("steps/frame.md", "Task instructions"),
    "Task instructions exceeds 128000 bytes; restore or edit the file, or abort the run.",
  );
});

test("stat failures take the unavailable path without reading (fx1)", () => {
  let reads = 0;
  const read = readBlockFrom(memFs({}, {
    stat: () => {
      throw Object.assign(new Error("EACCES: permission denied, stat '/w/steps/frame.md'"), { code: "EACCES" });
    },
    read: () => {
      reads += 1;
      return "# unreachable";
    },
  }));
  assert.equal(
    read("steps/frame.md", "Task instructions"),
    "Task instructions unavailable: EACCES: permission denied, stat '/w/steps/frame.md'. Restore the file or abort the run.",
  );
  assert.equal(reads, 0);
});

test("loop body prompts carry the iteration context and current item", () => {
  const wf = workflow([task("gather"), loop("review"), task("deliver")]);
  let state = start(wf, { runId: "run-2" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("gathered", { files: ["alpha.md", "beta.md"] })) }).state;
  const prompt = renderPositionEnvelope(
    wf,
    state,
    reader({ "WORKFLOW.md": "# Overview", "steps/gather.md": "# Gather", "steps/review-step.md": "# Review one", "steps/deliver.md": "# Deliver" }),
  );
  assert.match(prompt, /## Loop context/);
  assert.match(prompt, /Loop `review` \(for each\), iteration 1 of 2\./);
  assert.match(prompt, /Current item: "alpha\.md"/);
});

test("prior attempt context renders when the current key holds a checkpoint", () => {
  const wf = workflow([task("retry-me", { done: ["ok"], recovery: { maxAttempts: 2 } })]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("first attempt ended here") } }).state;
  assert.equal(state.stack.at(-1).attempt, 2, "the engine retries once at the same key");
  const prompt = renderPositionEnvelope(wf, state, reader({ "WORKFLOW.md": "# Overview", "steps/retry-me.md": "# Retry me" }));
  assert.match(prompt, /## Prior attempt at this position/, "the current key's checkpoint renders as a prior attempt");
  assert.match(prompt, /first attempt ended here/);
  assert.match(prompt, /attempt 2/, "the header states the attempt");
});

test("prior summaries are always rendered, capped at eight, and ordered oldest to newest", () => {
  const wf = workflow([task("a"), task("b"), task("c"), task("d"), task("e"), task("f"), task("g"), task("h"), task("i"), task("j"), task("k")]);
  let state = start(wf, { runId: "r1" }).state;
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
    state = transition(wf, state, { type: "outcome", outcome: completed(cp(`summary-${id}`)) }).state;
  }
  const prompt = renderPositionEnvelope(wf, state, reader({ "WORKFLOW.md": "# Overview", "steps/k.md": "# K" }));
  assert.match(prompt, /## Prior checkpoints/, "prior summaries always render, with or without inputs");
  const section = prompt.split("## Prior checkpoints")[1].split("##")[0];
  const entries = section.trim().split("\n").map((line) => line.trim());
  assert.equal(entries.length, 8, "at most eight prior summaries render");
  assert.match(entries[0], /summary-c/, "the oldest kept summary renders first");
  assert.match(entries.at(-1), /summary-j/, "the newest summary renders last");
  const bytes = Buffer.byteLength(entries.join("\n"), "utf8");
  assert.ok(bytes <= 8192, `the section stays within the ${8192}-byte budget (got ${bytes})`);
});

test("budget pressure drops the oldest summaries first", () => {
  const wf = workflow([task("a"), task("b"), task("c"), task("d"), task("e"), task("f"), task("g"), task("h"), task("i"), task("j")]);
  let state = start(wf, { runId: "r1" }).state;
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
    state = transition(wf, state, { type: "outcome", outcome: completed(cp(`summary-${id} ${"B".repeat(1400)}`)) }).state;
  }
  const prompt = renderPositionEnvelope(wf, state, reader({ "WORKFLOW.md": "# Overview", "steps/j.md": "# J" }));
  const section = prompt.split("## Prior checkpoints")[1].split("##")[0];
  assert.ok(!section.includes("summary-a"), "the oldest summary drops first under budget pressure");
  const entries = section.trim().split("\n").map((line) => line.trim());
  assert.equal(entries.length, 8, "the section caps at eight entries");
  assert.match(entries.at(-1), /summary-i/, "the newest summary survives");
  const bytes = Buffer.byteLength(entries.join("\n"), "utf8");
  assert.ok(bytes <= 8192, `the section stays within the ${8192}-byte budget (got ${bytes})`);
});

test("control messages name the run, position, and attempt", () => {
  const wf = workflow([task("frame", { done: ["f"] })]);
  let state = start(wf, { runId: "run-9" }).state;
  state = transition(wf, state, { type: "outcome", outcome: { status: "needs-work", checkpoint: cp("missed") } }).state;
  const message = controlMessage(state);
  assert.ok(
    message.startsWith(`Continue workflow \`run-9\` at ${state.stack.at(-1).key} (attempt 2).`),
    "the boundary message carries run id, position key, and attempt",
  );
});

