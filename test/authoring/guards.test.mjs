import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowManifest } from "../../src/authoring/parser.ts";

const roots = [];

function workflowDir(name, steps) {
  const root = mkdtempSync(join(tmpdir(), "gwf-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "steps/frame.md"), "---\ndescription: file\n---\n# Frame");
  writeFileSync(join(dir, "steps/deep.md"), "---\ndescription: file\n---\n# Deep");
  mkdirSync(join(dir, "operators"), { recursive: true });
  writeFileSync(join(dir, "operators/inspect.md"), "---\ndescription: Inspect.\n---\n# Inspect");
  const fm = ["description: Guarded run.", "steps:", steps, ""].join("\n");
  writeFileSync(join(dir, "WORKFLOW.md"), `---\n${fm}---\n\n# Overview\n`);
  return dir;
}

function load(dir) {
  try {
    loadWorkflowManifest(dir);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("guards parse onto tasks and register binding edges", () => {
  const dir = workflowDir("guarded", [
    "  - run: steps/frame.md",
    "    id: frame",
    "  - run: steps/deep.md",
    "    id: deep",
    "    when:",
    "      from: frame",
    "      select: /data/severity",
    "      op: in",
    "      value: [high, critical]",
  ].join("\n"));
  const wf = loadWorkflowManifest(dir);
  assert.equal(wf.root.children[1].guard.op, "in");
  assert.deepEqual(wf.root.children[1].guard.value, ["high", "critical"]);
  assert.equal(wf.root.children[1].guard.select, "/data/severity");
  assert.deepEqual(wf.inputEdges.get("deep"), ["frame"]);
});

test("guards parse onto plan blocks", () => {
  const dir = workflowDir("plan-guard", [
    "  - run: steps/frame.md",
    "    id: frame",
    "  - id: investigate",
    "    when:",
    "      from: frame",
    "      op: not-exists",
    "      select: /data/findings",
    "    plan:",
    "      operators: [inspect]",
  ].join("\n"));
  const wf = loadWorkflowManifest(dir);
  const block = wf.root.children[1];
  assert.equal(block.kind, "plan");
  assert.equal(block.guard.op, "not-exists");
  assert.deepEqual(wf.inputEdges.get("investigate"), ["frame"]);
});

test("unknown guard ops are rejected", () => {
  const dir = workflowDir("bad-op", [
    "  - run: steps/frame.md",
    "    id: frame",
    "  - run: steps/deep.md",
    "    id: deep",
    "    when:",
    "      from: frame",
    "      op: matches",
    "      value: x",
  ].join("\n"));
  const result = load(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /op must be one of/);
});

test("value shape is enforced per op", () => {
  const cases = [
    { op: "equals", value: [1], error: /must be a scalar/ },
    { op: "in", value: "high", error: /must be a non-empty list/ },
    { op: "gt", value: "many", error: /must be a finite number/ },
  ];
  for (const { op, value, error } of cases) {
    const dir = workflowDir(`shape-${op}`, [
      "  - run: steps/frame.md",
      "    id: frame",
      "  - run: steps/deep.md",
      "    id: deep",
      "    when:",
      "      from: frame",
      `      op: ${op}`,
      `      value: ${JSON.stringify(value)}`,
    ].join("\n"));
    const result = load(dir);
    assert.equal(result.ok, false, op);
    assert.match(result.error, error);
  }
});

test("exists ops reject values and value ops require them", () => {
  const withValue = workflowDir("exists-value", [
    "  - run: steps/frame.md",
    "    id: frame",
    "  - run: steps/deep.md",
    "    id: deep",
    "    when:",
    "      from: frame",
    "      op: exists",
    "      value: true",
  ].join("\n"));
  assert.match(load(withValue).error, /only accepted with a comparison op/);

  const missing = workflowDir("missing-value", [
    "  - run: steps/frame.md",
    "    id: frame",
    "  - run: steps/deep.md",
    "    id: deep",
    "    when:",
    "      from: frame",
    "      op: equals",
  ].join("\n"));
  assert.match(load(missing).error, /requires a value/);
});

test("guard producers must be earlier steps", () => {
  const self = workflowDir("self-guard", [
    "  - run: steps/frame.md",
    "    id: frame",
    "    when:",
    "      from: frame",
    "      op: exists",
  ].join("\n"));
  assert.match(load(self).error, /not an earlier step/);

  const later = workflowDir("later-guard", [
    "  - run: steps/deep.md",
    "    id: deep",
    "    when:",
    "      from: frame",
    "      op: exists",
    "  - run: steps/frame.md",
    "    id: frame",
  ].join("\n"));
  assert.match(load(later).error, /not an earlier step/);
});

test("guard select must be a JSON Pointer", () => {
  const dir = workflowDir("bad-pointer", [
    "  - run: steps/frame.md",
    "    id: frame",
    "  - run: steps/deep.md",
    "    id: deep",
    "    when:",
    "      from: frame",
    "      select: data.severity",
    "      op: exists",
  ].join("\n"));
  assert.match(load(dir).error, /must be a JSON Pointer/);
});
