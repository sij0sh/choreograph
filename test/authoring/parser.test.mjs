import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows, loadWorkflowManifest } from "../../src/authoring/parser.ts";

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

test("structural blocks compile with shared fields and unique ids", () => {
  const dir = workflowDir("structured", `
description: Structural run.
piVisibility: true
tools: [read, bash]
model: anthropic/claude-haiku-4-5
steps:
  - id: frame
    run: steps/frame.md
    done: [scope-clear]
  - id: discover
    run: steps/discover.md
  - id: review
    for_each:
      items: $discover.files
      as: file
      do:
        - run: steps/frame.md
          id: inspect
  - id: refine
    repeat:
      max: 3
      until:
        equals: [$verify.passed, true]
      do:
        - run: steps/frame.md
          id: improve
  - id: route
    choose:
      value: $discover.mode
      cases:
        fast:
          - run: steps/frame.md
            id: quick
      fallback:
        - run: steps/frame.md
          id: thorough
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
  const review = byId.get("review");
  assert.equal(review.kind, "foreach");
  assert.deepEqual(review.items, { root: "discover", path: ["files"] });
  assert.equal(review.as, "file");
  assert.equal(review.body.id, "review-body");
  assert.equal(review.body.children[0].id, "inspect");
  const refine = byId.get("refine");
  assert.equal(refine.kind, "repeat");
  assert.equal(refine.max, 3);
  assert.deepEqual(refine.until, { op: "equals", left: { ref: { root: "verify", path: ["passed"] } }, right: { literal: true } });
  const route = byId.get("route");
  assert.equal(route.kind, "choose");
  assert.deepEqual(Object.keys(route.cases), ["fast"]);
  assert.equal(route.cases.fast.children[0].id, "quick");
  assert.equal(route.fallback.children[0].id, "thorough");
  const investigate = byId.get("investigate");
  assert.equal(investigate.kind, "plan");
  assert.deepEqual(investigate.operators, ["inspect-op", "trace-op"]);
  assert.deepEqual(investigate.recovery, { maxAttempts: 2, maxReplans: 2, strategy: ["retry", "invalidate", "replan", "block"] });
  const deliver = byId.get("deliver");
  assert.equal(deliver.kind, "task");
  assert.deepEqual(deliver.recovery, { maxAttempts: 2, maxReplans: 2, strategy: ["invalidate", "block"], scope: "investigate" });
});

test("obsolete authoring keys return migration errors", () => {
  const kinds = workflowDir("kinds", `
description: Old shapes.
steps:
  - run: steps/frame.md
    id: plan
    kind: planner
`);
  assert.throws(() => loadWorkflowManifest(kinds), /replaced by a "plan:" block/);
  const routes = workflowDir("routes", `
description: Old shapes.
steps:
  - run: steps/frame.md
    id: verify
    on:
      pass: deliver
`);
  assert.throws(() => loadWorkflowManifest(routes), /replaced by "repair:" recovery policy/);
  const pathKey = workflowDir("pathkey", `
description: Old shapes.
steps:
  - path: steps/frame.md
    id: frame
`);
  assert.throws(() => loadWorkflowManifest(pathKey), /renamed to "run:"/);
});

test("steps reject bad shapes", () => {
  const both = workflowDir("both", `
description: x
steps:
  - id: weird
    for_each:
      items: $a.list
      as: item
      do:
        - run: steps/frame.md
    plan:
      operators: [op]
`);
  assert.throws(() => loadWorkflowManifest(both), /combines for_each and plan/);
  const dup = workflowDir("dup", `
description: x
steps:
  - run: steps/frame.md
    id: frame
  - run: steps/frame.md
    id: frame
`);
  assert.throws(() => loadWorkflowManifest(dup), /already used/);
  const emptyDo = workflowDir("emptydo", `
description: x
steps:
  - id: loop
    for_each:
      items: $a.list
      as: item
      do: []
`);
  assert.throws(() => loadWorkflowManifest(emptyDo), /non-empty list/);
  const unknownOperator = workflowDir("unknownop", `
description: x
steps:
  - id: investigate
    plan:
      operators: [ghost]
`);
  assert.throws(() => loadWorkflowManifest(unknownOperator), /no operator file/);
  const taskKeyOnBlock = workflowDir("taskkey", `
description: x
steps:
  - id: loop
    for_each:
      items: $a.list
      as: item
      do:
        - run: steps/frame.md
    tools: [read]
`);
  assert.throws(() => loadWorkflowManifest(taskKeyOnBlock), /only applies to/);
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
