import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, transition } from "../../src/engine/interpreter.ts";
import { completed, cp, loop, memoryStore, script, task, workflow } from "../engine/helpers.mjs";
import { completedPlanNodeOf, isArtifactRef, producerArtifact } from "../../src/domain/artifacts.ts";
import { LIMITS } from "../../src/domain/limits.ts";
import { ArtifactStore } from "../../src/runtime/artifact-store.ts";
import { inlineRefs, refLoaderFor, resolveBinding, resolveScriptInputs } from "../../src/runtime/artifacts.ts";
import { inputSection } from "../../src/runtime/prompts-inputs.ts";
import { renderPositionEnvelope } from "../../src/runtime/prompts.ts";

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

test("producer artifacts and binding resolution share one shape dispatch", () => {
  const planBlock = { kind: "plan", id: "investigate", operators: ["inspect"] };
  const loopBlock = loop("each");
  const wf = workflow([task("frame"), planBlock, loopBlock], { operators: operators() });
  const planKey = "root/investigate";
  const plan = { version: 1, nodes: [PLAN.nodes[0]] };
  const result = cp("found", { entry: "main.ts" });
  const base = start(wf, { runId: "r1" }).state;
  const state = {
    ...base,
    checkpoints: {
      "root/frame": cp("framed"),
      "root/each": cp("looped", { mode: "for-each", iterations: 0, results: [] }),
    },
    checkpointOrder: ["root/frame", "root/each"],
    plans: { [planKey]: { blockId: "investigate", plan, results: { probe: result } } },
  };

  for (const blockId of ["frame", "investigate", "each"]) {
    const artifact = producerArtifact(wf, state, blockId);
    const binding = resolveBinding(wf, state, { from: blockId });
    assert.equal(artifact.ok && artifact.present, true, blockId);
    assert.equal(binding.ok, true, blockId);
    assert.deepEqual(binding.value, artifact.value, blockId);
  }

  assert.deepEqual(completedPlanNodeOf(state.plans[planKey], "probe"), { node: plan.nodes[0], result });
  assert.equal(completedPlanNodeOf(state.plans[planKey], "missing"), undefined);

  const incomplete = { ...state, checkpoints: {}, checkpointOrder: [], plans: {} };
  assert.equal(producerArtifact(wf, incomplete, "frame").present, false);
  assert.match(resolveBinding(wf, incomplete, { from: "frame" }).error, /no recorded checkpoint/);
  assert.equal(producerArtifact(wf, incomplete, "investigate").present, false);
  assert.match(resolveBinding(wf, incomplete, { from: "investigate" }).error, /has not produced a plan/);
  assert.equal(producerArtifact(wf, incomplete, "each").present, false);
  assert.match(resolveBinding(wf, incomplete, { from: "each" }).error, /has not completed its loop/);

  const skipped = { ...incomplete, checkpoints: { [planKey]: cp("skipped") }, checkpointOrder: [planKey] };
  skipped.checkpoints[planKey].skipped = true;
  const skippedArtifact = producerArtifact(wf, skipped, "investigate");
  assert.equal(skippedArtifact.present, false);
  assert.equal(skippedArtifact.skipped.skipped, true);
  assert.deepEqual(resolveBinding(wf, skipped, { from: "investigate" }).value, skipped.checkpoints[planKey]);
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
  const prompt = renderPositionEnvelope(ordered, state, reader({
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
  const prompt = renderPositionEnvelope(wf, state, reader({
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
  const prompt = renderPositionEnvelope(wf, state, reader({ "WORKFLOW.md": "# Overview", "steps/frame.md": "# Frame" }));
  assert.ok(!prompt.includes("## Inputs"), "no inputs section without bindings");
  assert.match(prompt, /# Frame/);
});

test("script checkpoints and loop aggregates bind downstream", () => {
  const wf = workflow([
    script("probe", { spec: { stdout: "json" } }),
    task("use", { inputs: { from_script: { from: "probe", select: "/data/pass" } } }),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, {
    type: "process-exit",
    key: "root/probe",
    exit: { code: 0, timedOut: false, stdout: '{"pass":7,"fail":0}\n', stderr: "", truncated: false },
  }).state;
  const binding = resolveBinding(wf, state, { from: "probe", select: "/data/pass" });
  assert.equal(binding.ok, true);
  assert.equal(binding.value, 7);

  const section = inputSection(wf, state, { from_script: { from: "probe", select: "/data/pass" } });
  assert.match(section, /## Inputs/);
  assert.match(section, /`from_script` from `probe`/);
});

test("$item binds the current loop item inside the body", () => {
  const wf = workflow([
    task("gather"),
    loop("review", { body: { inputs: { item: { from: "$item" }, name: { from: "$item", select: "/name" } } } }),
    task("deliver"),
  ]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: [{ name: "a" }, { name: "b" }] })) }).state;
  const first = resolveBinding(wf, state, { from: "$item", select: "/name" });
  assert.equal(first.ok, true);
  assert.equal(first.value, "a");
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("reviewed a")) }).state;
  const second = resolveBinding(wf, state, { from: "$item" });
  assert.equal(second.ok, true);
  assert.deepEqual(second.value, { name: "b" });

  const outside = resolveBinding(wf, state, { from: "deliver" });
  assert.equal(outside.ok, false);

  const plain = workflow([task("gather"), task("deliver")]);
  const plainState = start(plain, { runId: "r1" }).state;
  const noItem = resolveBinding(plain, plainState, { from: "$item" });
  assert.equal(noItem.ok, false);
  assert.match(noItem.error, /only inside a for_each loop body/);

  const section = inputSection(wf, state, { item: { from: "$item" }, name: { from: "$item", select: "/name" } });
  assert.match(section, /`item` from `\$item`/);
  assert.match(section, /\{"name":"b"\}/);
  assert.match(section, /"b"/);
});

test("a completed loop aggregate is a downstream binding source", () => {
  const wf = workflow([task("gather"), loop("review"), task("deliver", { inputs: { review: { from: "review", select: "/iterations" } } })]);
  const store = memoryStore();
  let state = start(wf, { runId: "r1" }, store).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: ["a", "b"] })) }, store).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("reviewed a")) }, store).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("reviewed b")) }, store).state;
  const binding = resolveBinding(wf, state, { from: "review" });
  assert.equal(binding.ok, true);
  assert.equal(binding.value.data.mode, "for-each");
  assert.equal(binding.value.data.iterations, 2);
  assert.deepEqual(binding.value.data.results.map((record) => record.item), ["a", "b"]);
  const selected = resolveBinding(wf, state, { from: "review", select: "/data/results/1/item" });
  assert.equal(selected.ok, true);
  assert.equal(selected.value, "b");
  assert.match(inputSection(wf, state, { review: { from: "review", select: "/data/iterations" } }), /`review` from `review`/);
  assert.match(inputSection(wf, state, { review: { from: "review", select: "/data/iterations" } }), /\b2\b/);
});

test("loop aggregate references resolve downstream transparently", () => {
  const root = mkdtempSync(join(tmpdir(), "pwf-agg-"));
  try {
    const store = ArtifactStore.forRun(root, "r1");
    const wf = workflow([
      task("gather"),
      loop("review"),
      script("consume", { spec: { stdout: "json" }, inputs: { finding: { from: "review", select: "/data/results/0/outputs/review-step" } } }),
    ]);
    let state = start(wf, { runId: "r1" }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: ["a", "b"] })) }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("reviewed a", { verdict: "ship it" })) }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("reviewed b", { verdict: "hold" })) }, store).state;

    const ref = state.checkpoints["root/review"].data.results[0].outputs["review-step"];
    const binding = resolveBinding(wf, state, { from: "review", select: "/data/results/0/outputs/review-step" });
    assert.equal(binding.ok, true);
    assert.deepEqual(binding.value, ref, "the aggregate stores references, not payloads");

    const resolved = resolveScriptInputs(wf, state, wf.root.children[2].inputs, (r) => store.materialize(r, root));
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
    const onDisk = JSON.parse(readFileSync(join(root, resolved.inputs.finding), "utf8"));
    assert.deepEqual(onDisk, { verdict: "ship it" }, "materialized references carry the stored payload");

    const load = refLoaderFor(store);
    const section = inputSection(wf, state, { finding: { from: "review", select: "/data/results/0/outputs/review-step" } }, load);
    assert.match(section, /\{"verdict":"ship it"\}/, "prompt inputs render the loaded value");
    assert.ok(!section.includes(ref.checksum), "prompt inputs never show the raw reference");

    const inline = inlineRefs({ results: state.checkpoints["root/review"].data.results }, load);
    assert.equal(inline.ok, true);
    assert.deepEqual(inline.value.results[1].outputs["review-step"], { verdict: "hold" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("over-budget body outputs bind the payload, not a reference of a reference", () => {
  const root = mkdtempSync(join(tmpdir(), "pwf-agg-oversize-"));
  try {
    const store = ArtifactStore.forRun(root, "r1");
    const wf = workflow([
      task("gather"),
      {
        kind: "loop", id: "review", maxIterations: 8,
        body: script("review-step", { spec: { stdout: "json" } }),
        itemsBinding: { from: "gather", select: "/data/files" },
      },
      script("consume", { spec: { stdout: "json" }, inputs: { finding: { from: "review", select: "/data/results/0/outputs/review-step" } } }),
    ]);
    const payload = { blob: "x".repeat(LIMITS.checkpointBytes) };
    const exit = (file) => ({
      type: "process-exit",
      key: `root/review/loop[${file === "a" ? 1 : 2}]/review-step`,
      exit: { code: 0, timedOut: false, stdout: `${JSON.stringify({ file, blob: payload.blob })}\n`, stderr: "", truncated: false },
      store: store.sinkFor(`root/review/loop[${file === "a" ? 1 : 2}]/review-step`),
    });
    let state = start(wf, { runId: "r1" }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("g", { files: ["a", "b"] })) }, store).state;
    state = transition(wf, state, exit("a"), store).state;
    state = transition(wf, state, exit("b"), store).state;

    const bodyRef = state.checkpoints["root/review/loop[1]/review-step"].data;
    assert.ok(isArtifactRef(bodyRef), "the oversized body checkpoint stores a reference");
    const ref = state.checkpoints["root/review"].data.results[0].outputs["review-step"];
    assert.deepEqual(ref, bodyRef, "the aggregate reuses the body reference instead of re-wrapping it");
    assert.ok(ref.size > LIMITS.checkpointBytes, "the reference addresses the payload, not a small ref-JSON");

    const loaded = store.load(ref);
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
    assert.deepEqual(JSON.parse(loaded.ok ? loaded.content.toString("utf8") : ""), { file: "a", blob: payload.blob });

    const resolved = resolveScriptInputs(wf, state, wf.root.children[2].inputs, (r) => store.materialize(r, root));
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
    const onDisk = JSON.parse(readFileSync(join(root, resolved.inputs.finding), "utf8"));
    assert.deepEqual(onDisk, { file: "a", blob: payload.blob }, "downstream materialization yields the payload");

    const inline = inlineRefs({ results: state.checkpoints["root/review"].data.results }, refLoaderFor(store));
    assert.equal(inline.ok, true);
    assert.deepEqual(inline.value.results[1].outputs["review-step"], { file: "b", blob: payload.blob });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("$item values resolve their references for scripts and prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "pwf-item-"));
  try {
    const store = ArtifactStore.forRun(root, "r1");
    const wf = workflow([
      task("seed"),
      loop("first", { itemsBinding: { from: "seed", select: "/data/files" }, body: { inputs: { one: { from: "$item" } } } }),
      loop("review", { itemsBinding: { from: "first", select: "/data/results" }, body: { inputs: { prior: { from: "$item", select: "/outputs/first-step" } } } }),
      task("deliver"),
    ]);
    let state = start(wf, { runId: "r1" }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("seeded", { files: ["a"] })) }, store).state;
    state = transition(wf, state, { type: "outcome", outcome: completed(cp("first pass", { ok: true })) }, store).state;
    const binding = resolveBinding(wf, state, { from: "$item", select: "/outputs/first-step" });
    assert.equal(binding.ok, true);
    assert.equal(binding.value.checksum, state.checkpoints["root/first"].data.results[0].outputs["first-step"].checksum, "$item carries the upstream reference");

    const resolved = resolveScriptInputs(wf, state, wf.root.children[2].body.inputs, (r) => store.materialize(r, root));
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
    const onDisk = JSON.parse(readFileSync(join(root, resolved.inputs.prior), "utf8"));
    assert.deepEqual(onDisk, { ok: true });

    const section = inputSection(wf, state, { prior: { from: "$item", select: "/outputs/first-step" } }, refLoaderFor(store));
    assert.match(section, /\{"ok":true\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("script inputs resolve through declared bindings before execution", () => {
  const wf = workflow([task("frame"), script("probe", { spec: { stdout: "json" }, inputs: { id: { from: "frame", select: "/data/id" }, whole: { from: "frame" } } })]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { id: "main.ts" })) }).state;
  const block = wf.root.children[1];

  const resolved = resolveScriptInputs(wf, state, block.inputs);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.inputs, { id: "main.ts", whole: { summary: "framed", data: { id: "main.ts" } } });

  const early = resolveScriptInputs(wf, { ...state, checkpoints: {}, checkpointOrder: [] }, block.inputs);
  assert.equal(early.ok, false);
  assert.match(early.error, /input "id".*no recorded checkpoint/);

  const nothing = resolveScriptInputs(wf, state, undefined);
  assert.deepEqual(nothing, { ok: true, inputs: {} });
});

const REF = { invocationKey: "root/emit#1", output: "output", checksum: `sha256-${"a".repeat(64)}`, size: 30_000, mediaType: "application/json" };

test("script inputs materialize artifact references into workspace paths", () => {
  const wf = workflow([task("frame"), script("consume")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { payload: REF })) }).state;
  const materialize = (ref) => ({ ok: true, path: `.choreograph/artifacts/${ref.checksum.slice("sha256-".length)}` });
  const resolved = resolveScriptInputs(wf, state, { payload: { from: "frame", select: "/data/payload" } }, materialize);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.inputs.payload, `.choreograph/artifacts/${"a".repeat(64)}`);
});

test("materialization walks nested structures and replaces every reference", () => {
  const wf = workflow([task("frame"), script("consume")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { output: REF, keep: { deep: [REF] } })) }).state;
  const seen = [];
  const materialize = (ref) => {
    seen.push(ref.output);
    return { ok: true, path: `files/${seen.length}` };
  };
  const resolved = resolveScriptInputs(wf, state, { whole: { from: "frame", select: "/data" } }, materialize);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.inputs.whole, { output: "files/1", keep: { deep: ["files/2"] } });
  assert.deepEqual(seen, ["output", "output"]);
});

test("a materialization failure fails input resolution with the input name", () => {
  const wf = workflow([task("frame"), script("consume")]);
  let state = start(wf, { runId: "r1" }).state;
  state = transition(wf, state, { type: "outcome", outcome: completed(cp("framed", { payload: REF })) }).state;
  const resolved = resolveScriptInputs(wf, state, { payload: { from: "frame", select: "/data/payload" } }, () => ({ ok: false, error: "object is missing" }));
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /input "payload"/);
  assert.match(resolved.error, /object is missing/);
});
