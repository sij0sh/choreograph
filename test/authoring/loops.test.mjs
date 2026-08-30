import test from "node:test";
import { assert, loadWorkflowManifest, workflowDir } from "./helpers.mjs";

test("for_each compiles into a loop block with a single-task body", () => {
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
`);
  const wf = loadWorkflowManifest(dir);
  const each = wf.root.children[1];
  assert.equal(each.kind, "loop");
  assert.equal(each.maxIterations, 8);
  assert.deepEqual(each.itemsBinding, { from: "gather", select: "/data/files" });
  assert.equal(each.body.kind, "task");
  assert.equal(each.body.id, "discover");
  assert.equal(each.body.instructionPath.endsWith("steps/discover.md"), true);
  assert.equal(each.guard, undefined);
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
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md }
      maxItems: 9
`, /maxItems must be an integer between 1 and 8/],
    ["body-mixes", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md, tools: [read] }
      maxItems: 4
`, /is not accepted; a loop body holds one "run" step/],
    ["body-steps", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body:
        steps:
          - run: steps/frame.md
      maxItems: 4
`, /body.steps is not accepted; a loop body holds one "run" step/],
    ["repeat-until-key", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    repeat_until:
      body: { run: steps/frame.md }
      when: { from: gather, op: exists }
      maxIterations: 4
`, /unknown steps\[1\] key: repeat_until/],
    ["loop-repair", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md }
      maxItems: 4
      repair: { max_attempts: 3 }
`, /unknown steps\[1\].for_each key: repair/],
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
      maxIterations: 4
`, /unknown steps\[1\] key: repeat_until/],
    ["bad-items-field", `
steps:
  - id: gather
    run: steps/frame.md
  - id: bad
    for_each:
      items: { from: gather, mode: fast }
      body: { run: steps/frame.md }
      maxItems: 4
`, /items.mode is not an accepted binding field/],
  ];
  for (const [name, frontmatter, pattern] of cases) {
    const dir = workflowDir(name, `description: x\n${frontmatter}`);
    assert.throws(() => loadWorkflowManifest(dir), pattern, name);
  }
});

test("items are validated before the body is parsed", () => {
  const dir = workflowDir("items-first", `
description: Items first.
steps:
  - id: bad
    for_each:
      items: { from: gather }
      body: { run: steps/frame.md, tools: [read] }
      maxItems: 4
`);
  assert.throws(
    () => loadWorkflowManifest(dir),
    /items.from names "gather", which is not an earlier step/,
    "the items binding error surfaces before any body parsing error",
  );
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
  assert.equal(loopBlock.body.kind, "task");
  assert.deepEqual(loopBlock.body.inputs, {
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
