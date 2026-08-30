import test from "node:test";
import { assert, join, loadWorkflowManifest, mkdirSync, workflowDir, writeFileSync } from "./helpers.mjs";

test("for_each and repeat_until compile into loop blocks", () => {
  const dir = workflowDir("loops", `
description: Loop run.
steps:
  - id: gather
    run: steps/frame.md
  - id: review-files
    for_each:
      items: { from: gather, select: /data/files }
      body: { run: steps/discover.md }
      maxItems: 8
  - id: fix-until-green
    repeat_until:
      body: { run: steps/02-deliver.md }
      when: { from: deliver, select: /data/exitCode, op: equals, value: 0 }
      maxIterations: 3
`);
  const wf = loadWorkflowManifest(dir);
  const each = wf.root.children[1];
  assert.equal(each.kind, "loop");
  assert.equal(each.mode, "for-each");
  assert.equal(each.maxIterations, 8);
  assert.deepEqual(each.itemsBinding, { from: "gather", select: "/data/files" });
  assert.equal(each.body.kind, "sequence");
  assert.equal(each.body.id, "review-files-body");
  assert.equal(each.body.children[0].instructionPath.endsWith("steps/discover.md"), true);
  const repeat = wf.root.children[2];
  assert.equal(repeat.kind, "loop");
  assert.equal(repeat.mode, "repeat-until");
  assert.equal(repeat.maxIterations, 3);
  assert.deepEqual(repeat.condition, { from: "deliver", select: "/data/exitCode", op: "equals", value: 0 });
  assert.equal(each.recovery, undefined);
});

test("loop steps reject bad shapes", () => {
  const cases = [
    ["mixed-keys", `
steps:
  - id: bad
    run: steps/frame.md
    for_each:
      items: { from: gather, select: /data/files }
      body: { run: steps/frame.md }
      maxItems: 4
`, /only applies to "run:" tasks/],
    ["missing-cap", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md }
`, /for_each.maxItems must be an integer between 1 and 8/],
    ["cap-too-large", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    repeat_until:
      body: { run: steps/frame.md }
      when: { from: gather, op: exists }
      maxIterations: 9
`, /maxIterations must be an integer between 1 and 8/],
    ["body-mixes", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md, tools: [read] }
      maxItems: 4
`, /is not accepted; a loop body holds "run" \(one step\) or "steps"/],
    ["for-each-when", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md }
      when: { from: gather, op: exists }
      maxItems: 4
`, /for_each.when is only accepted by repeat_until/],
    ["repeat-items", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    repeat_until:
      body: { run: steps/frame.md }
      items: { from: gather }
      when: { from: gather, op: exists }
      maxIterations: 4
`, /repeat_until.items is only accepted by for_each/],
    ["forward-ref", `
steps:
  - id: bad
    for_each:
      items: { from: gather, select: /data/files }
      body: { run: steps/frame.md }
      maxItems: 4
`, /which is not an earlier step/],
    ["both-kinds", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md }
      maxItems: 4
    repeat_until:
      body: { run: steps/frame.md }
      when: { from: gather, op: exists }
      maxIterations: 4
`, /declares more than one of/],
    ["bad-when-op", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    repeat_until:
      body: { run: steps/frame.md }
      when: { from: gather, op: approximately }
      maxIterations: 4
`, /when.op must be one of/],
  ];
  for (const [name, frontmatter, pattern] of cases) {
    const dir = workflowDir(name, `description: x\n${frontmatter}`);
    assert.throws(() => loadWorkflowManifest(dir), pattern, name);
  }
});

test("loop body inputs bind the current item", () => {
  const dir = workflowDir("loop-item", `
description: Loop item run.
steps:
  - id: gather
    run: steps/frame.md
  - id: review
    for_each:
      items: { from: gather, select: /data/files }
      body: { run: steps/discover.md, inputs: { item: { from: "$item" }, name: { from: "$item", select: "/name" } } }
      maxItems: 8
`);
  const wf = loadWorkflowManifest(dir);
  const loopBlock = wf.root.children[1];
  assert.equal(loopBlock.kind, "loop");
  const bodyStep = loopBlock.body.children[0];
  assert.deepEqual(bodyStep.inputs, {
    item: { from: "$item" },
    name: { from: "$item", select: "/name" },
  });
});

test("loop body inputs reject non-item producers", () => {
  const cases = [
    ["body-rejects-unknown", `
description: Reject unknown producers.
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md, inputs: { file: { from: missing } } }
      maxItems: 4
`, /body.inputs.file.from names "missing", which is not an earlier step/],
    ["step-rejects-item", `
description: Reject item outside loops.
steps:
  - id: bad
    run: steps/frame.md
    inputs: { item: { from: "$item" } }
`, /from "\$item" is only available inside a loop body/],
    ["guard-rejects-item", `
description: Reject item in guards.
steps:
  - id: bad
    run: steps/frame.md
    when: { from: "$item", op: exists }
`, /when.from must match/],
  ];
  for (const [name, frontmatter, match] of cases) {
    const dir = workflowDir(name, frontmatter);
    assert.throws(() => loadWorkflowManifest(dir), match, name);
  }
});

test("multi-step loop bodies parse with tasks, scripts, and item or outer inputs", () => {
  const dir = workflowDir("loop-steps", `
description: Multi-step body.
contracts:
  report: contracts/report.schema.json
steps:
  - id: gather
    run: steps/frame.md
  - id: review-files
    for_each:
      items: { from: gather, select: /data/files }
      maxItems: 4
      body:
        steps:
          - id: read-one
            run: steps/read-one.md
            inputs: { item: { from: "$item" }, scope: { from: gather, select: "/data/scope" } }
          - id: check-one
            script:
              argv: [node, check.mjs]
              stdout: json
            inputs: { report: { from: read-one } }
            output: report
`, { files: ["steps/frame.md", "steps/read-one.md"] });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  writeFileSync(join(dir, "contracts", "report.schema.json"), JSON.stringify({ type: "object" }));
  const wf = loadWorkflowManifest(dir);
  const loopBlock = wf.root.children[1];
  assert.equal(loopBlock.kind, "loop");
  assert.equal(loopBlock.body.children.length, 2, "the body keeps both steps in order");
  const [readOne, checkOne] = loopBlock.body.children;
  assert.equal(readOne.kind, "task");
  assert.deepEqual(readOne.inputs, { item: { from: "$item" }, scope: { from: "gather", select: "/data/scope" } });
  assert.equal(wf.inputEdges.get("read-one")?.includes("gather"), true, "the outer producer is recorded as an input edge");
  assert.equal(checkOne.kind, "script");
  assert.deepEqual(checkOne.inputs, { report: { from: "read-one" } });
  assert.equal(checkOne.output, "report");
});

test("multi-step loop bodies reject nested loops, plans, mixed forms, and overlong lists", () => {
  const cases = [
    ["nested-loop", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      maxItems: 2
      body:
        steps:
          - id: inner
            for_each:
              items: { from: gather }
              body: { run: steps/frame.md }
              maxItems: 2
`, /must not nest loops/],
    ["plan-in-body", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      maxItems: 2
      body:
        steps:
          - id: plan-step
            plan:
              operators: [inspect]
`, /must not contain a plan/, { operators: { inspect: "---\ndescription: Inspect.\n---\nbody" } }],
    ["mixed-forms", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      maxItems: 2
      body:
        run: steps/frame.md
        steps:
          - run: steps/frame.md
`, /declares both "run" and "steps"/],
    ["too-many-steps", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      maxItems: 2
      body:
        steps:
${Array.from({ length: 9 }, (_, i) => `          - id: body-${i}\n            run: steps/frame.md`).join("\n")}
`, /holds 9 entries; a loop body holds at most 8/],
  ];
  for (const [name, frontmatter, pattern, options] of cases) {
    const dir = workflowDir(name, `description: x\n${frontmatter}`, options);
    assert.throws(() => loadWorkflowManifest(dir), pattern, name);
  }
});
