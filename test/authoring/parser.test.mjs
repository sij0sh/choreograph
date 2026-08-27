import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows, loadWorkflowManifest } from "../../src/authoring/parser.ts";
import { LIMITS } from "../../src/domain/limits.ts";

const roots = [];

function workflowDir(name, frontmatter, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pwf-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "steps"), { recursive: true });
  for (const file of options.files ?? ["steps/frame.md", "steps/01-frame.md", "steps/02-deliver.md", "steps/discover.md"]) {
    mkdirSync(join(dir, file.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, file), `---\ndescription: file\n---\n# ${file}`);
  }
  for (const [id, body] of Object.entries(options.operators ?? {})) {
    mkdirSync(join(dir, "operators"), { recursive: true });
    writeFileSync(join(dir, "operators", `${id}.md`), body);
  }
  writeFileSync(join(dir, "WORKFLOW.md"), `---\n${frontmatter.trim()}\n---\n\n# Overview\n`);
  return dir;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("legacy string steps compile into a task sequence", () => {
  const dir = workflowDir("legacy", `
description: Legacy run.
steps:
  - steps/01-frame.md
  - steps/02-deliver.md
`);
  const wf = loadWorkflowManifest(dir);
  assert.equal(wf.name, "legacy");
  assert.equal(wf.title, "Legacy");
  assert.equal(wf.piVisibility, false);
  assert.equal(wf.root.id, "root");
  assert.deepEqual(
    wf.root.children.map((child) => [child.kind, child.id]),
    [
      ["task", "frame"],
      ["task", "deliver"],
    ],
  );
  assert.equal(wf.root.children[0].instructionPath.endsWith("steps/01-frame.md"), true);
});

test("plan blocks compile with shared fields and unique ids", () => {
  const dir = workflowDir("structured", `
description: Structural run.
piVisibility: true
legalTools: [read, bash]
steps:
  - id: frame
    run: steps/frame.md
    done: [scope-clear]
  - id: discover
    run: steps/discover.md
  - id: investigate
    plan:
      operators: [inspect-op, trace-op]
      repair:
        max_attempts: 2
        max_replans: 2
  - id: deliver
    run: steps/frame.md
    repair:
      strategy: [invalidate, block]
      scope: investigate
`, {
    files: ["steps/frame.md", "steps/discover.md"],
    operators: {
      "inspect-op": "---\ndescription: Inspect.\n---\nbody",
      "trace-op": "---\ndescription: Trace.\n---\nbody",
    },
  });
  const wf = loadWorkflowManifest(dir);
  assert.equal(wf.piVisibility, true);
  assert.deepEqual([...wf.tools], ["read", "bash"]);
  const byId = new Map(wf.root.children.map((child) => [child.id, child]));
  const investigate = byId.get("investigate");
  assert.equal(investigate.kind, "plan");
  assert.deepEqual(investigate.operators, ["inspect-op", "trace-op"]);
  assert.deepEqual(investigate.recovery, { maxAttempts: 2, maxReplans: 2, strategy: ["retry", "invalidate", "replan", "block"] });
  const deliver = byId.get("deliver");
  assert.equal(deliver.kind, "task");
  assert.deepEqual(deliver.recovery, { maxAttempts: 2, maxReplans: 2, strategy: ["invalidate", "block"], scope: "investigate" });
});


test("obsolete authoring keys return unknown-key errors", () => {
  const kinds = workflowDir("kinds", `
description: Old shapes.
steps:
  - run: steps/frame.md
    id: plan
    kind: planner
`);
  assert.throws(() => loadWorkflowManifest(kinds), /unknown steps\[0\] key: kind/);
  const routes = workflowDir("routes", `
description: Old shapes.
steps:
  - run: steps/frame.md
    id: verify
    on:
      pass: deliver
`);
  assert.throws(() => loadWorkflowManifest(routes), /unknown steps\[0\] key: on/);
  const pathKey = workflowDir("pathkey", `
description: Old shapes.
steps:
  - path: steps/frame.md
    id: frame
`);
  assert.throws(() => loadWorkflowManifest(pathKey), /unknown steps\[0\] key: path/);
  const alias = workflowDir("alias", `
description: Old shapes.
tools: [read]
steps:
  - run: steps/frame.md
`);
  assert.throws(() => loadWorkflowManifest(alias), /unknown frontmatter key: tools/);
});


test("steps reject bad shapes", () => {
  const unknownKey = workflowDir("unknownkey", `
description: x
steps:
  - id: weird
    script: [npm, test]
`);
  assert.throws(() => loadWorkflowManifest(unknownKey), /unknown steps\[0\] key: script/);
  const taskKeyOnPlan = workflowDir("taskkey", `
description: x
steps:
  - id: investigate
    plan:
      operators: [inspect-op]
    tools: [read]
`, { operators: { "inspect-op": "---\ndescription: Inspect.\n---\nbody" } });
  assert.throws(() => loadWorkflowManifest(taskKeyOnPlan), /only applies to/);
  const dup = workflowDir("dup", `
description: x
steps:
  - run: steps/frame.md
    id: frame
  - run: steps/frame.md
    id: frame
`);
  assert.throws(() => loadWorkflowManifest(dup), /already used/);
  const unknownOperator = workflowDir("unknownop", `
description: x
steps:
  - id: investigate
    plan:
      operators: [ghost]
`);
  assert.throws(() => loadWorkflowManifest(unknownOperator), /no operator file/);
});

test("repair bounds stay within the persisted run bounds", () => {
  const attempts = workflowDir("attempts", `
description: x
steps:
  - run: steps/frame.md
    repair:
      max_attempts: ${LIMITS.nodeAttempts + 2}
`);
  assert.throws(() => loadWorkflowManifest(attempts), new RegExp(`between 1 and ${LIMITS.nodeAttempts + 1}`));
  const replans = workflowDir("replans", `
description: x
steps:
  - run: steps/frame.md
    repair:
      max_replans: ${LIMITS.replans + 1}
`);
  assert.throws(() => loadWorkflowManifest(replans), new RegExp(`between 1 and ${LIMITS.replans}`));
  const edge = loadWorkflowManifest(workflowDir("edge", `
description: x
steps:
  - run: steps/frame.md
    repair:
      max_attempts: ${LIMITS.nodeAttempts + 1}
      max_replans: ${LIMITS.replans}
`));
  const task = edge.root.children[0];
  assert.equal(task.recovery.maxAttempts, LIMITS.nodeAttempts + 1);
  assert.equal(task.recovery.maxReplans, LIMITS.replans);
});

test("containment and size rules still hold", () => {
  const escape = workflowDir("escape", `
description: x
steps:
  - run: ../outside.md
`);
  assert.throws(() => loadWorkflowManifest(escape), /escapes the workflow directory/);
  const absolute = workflowDir("absolute", `
description: x
steps:
  - run: /etc/passwd.md
`);
  assert.throws(() => loadWorkflowManifest(absolute), /must be relative/);
});

test("discovery isolates invalid workflows and skips silent directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pwf-"));
  roots.push(root);
  mkdirSync(join(root, "good"), { recursive: true });
  writeFileSync(join(root, "good", "WORKFLOW.md"), `---\ndescription: ok\nsteps:\n  - steps/a.md\n---\n`);
  mkdirSync(join(root, "good", "steps"));
  writeFileSync(join(root, "good", "steps", "a.md"), "# A");
  mkdirSync(join(root, "bad"));
  writeFileSync(join(root, "bad", "WORKFLOW.md"), `---\ndescription: bad\nsteps: []\n---\n`);
  mkdirSync(join(root, "silent"));
  const { workflows, diagnostics } = discoverWorkflows(root);
  assert.deepEqual(workflows.map((wf) => wf.name), ["good"]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].error, /non-empty/);
});

test("discovery treats an absent root as an empty installation", () => {
  const { workflows, diagnostics } = discoverWorkflows(join(tmpdir(), `absent-${Date.now()}`));
  assert.deepEqual(workflows, []);
  assert.deepEqual(diagnostics, []);
});

test("discovery accepts symlinked workflow directories and skips invalid links", () => {
  const root = mkdtempSync(join(tmpdir(), "pwf-link-"));
  roots.push(root);
  mkdirSync(join(root, "real-flow", "steps"), { recursive: true });
  writeFileSync(join(root, "real-flow", "WORKFLOW.md"), `---\ndescription: linked\nsteps:\n  - steps/a.md\n---\n`);
  writeFileSync(join(root, "real-flow", "steps", "a.md"), "# A");
  symlinkSync(join(root, "real-flow"), join(root, "link-flow"));
  symlinkSync(join(root, "real-flow", "WORKFLOW.md"), join(root, "file-link"));
  symlinkSync(join(root, "nowhere"), join(root, "broken-link"));
  const { workflows, diagnostics } = discoverWorkflows(root);
  assert.deepEqual(workflows.map((wf) => wf.name).sort(), ["link-flow", "real-flow"], "the symlinked directory loads like a real one");
  assert.equal(diagnostics.length, 0, "non-directory and broken links stay silently skipped");
});

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
`, /loop body is a single "run:" step/],
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
