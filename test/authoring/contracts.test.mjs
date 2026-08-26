import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowManifest } from "../../src/authoring/parser.ts";
import { LIMITS } from "../../src/domain/limits.ts";
import { compileContract } from "../../src/domain/contract.ts";
import { isValidJsonPointer, jsonPointerGet } from "../../src/domain/json.ts";

const roots = [];

function workflowDir(name, frontmatter, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pwf-contracts-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "steps"), { recursive: true });
  for (const file of options.files ?? ["steps/frame.md", "steps/deliver.md"]) {
    mkdirSync(join(dir, file.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, file), `---\ndescription: file\n---\n# ${file}`);
  }
  for (const [id, body] of Object.entries(options.operators ?? {})) {
    mkdirSync(join(dir, "operators"), { recursive: true });
    writeFileSync(join(dir, "operators", `${id}.md`), body);
  }
  for (const [id, schema] of Object.entries(options.contracts ?? {})) {
    mkdirSync(join(dir, "contracts"), { recursive: true });
    writeFileSync(join(dir, "contracts", `${id}.schema.json`), typeof schema === "string" ? schema : JSON.stringify(schema));
  }
  writeFileSync(join(dir, "WORKFLOW.md"), `---\n${frontmatter.trim()}\n---\n\n# Overview\n`);
  return dir;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("the contract compiler validates the accepted subset", () => {
  const validate = compileContract({
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string", minLength: 1 },
      severity: { enum: ["low", "high"] },
      count: { type: "integer", minimum: 0 },
      refs: { type: "array", maxItems: 4, items: { type: "string", pattern: "^[a-z-]+\\.ts$" } },
      mode: { oneOf: [{ const: "fast" }, { const: "deep" }] },
    },
  }, "contracts/finding");
  assert.deepEqual(validate({ summary: "ok", severity: "high", count: 2, refs: ["a.ts"], mode: "fast" }), []);
  const errors = validate({ summary: "", severity: "mid", count: -1, refs: ["A.ts", "b.ts"], mode: "slow", extra: true });
  assert.ok(errors.some((error) => error.includes("/summary")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("/severity")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("/count")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("/refs/0")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("/mode")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("property extra")), errors.join("; "));
  const strictObject = compileContract({ type: "object", additionalProperties: false }, "contracts/strict");
  assert.ok(strictObject({ extra: true }).some((error) => error.includes("property extra")));
  assert.throws(() => compileContract({ patternProperties: {} }, "contracts/x"), /unsupported keyword: patternProperties/);
  assert.throws(() => compileContract({ type: "unicorn" }, "contracts/x"), /type must be one of/);
  assert.throws(() => compileContract({ oneOf: [{}] }, "contracts/x"), /oneOf must contain/);
});

test("json pointers validate and resolve", () => {
  assert.equal(isValidJsonPointer(""), true);
  assert.equal(isValidJsonPointer("/nodes/0/id"), true);
  assert.equal(isValidJsonPointer("/a~1b"), true);
  assert.equal(isValidJsonPointer("nodes[0]"), false);
  assert.equal(isValidJsonPointer("nodes/0"), false);
  const value = { nodes: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(jsonPointerGet(value, "/nodes/1/id"), { ok: true, value: "b" });
  assert.equal(jsonPointerGet(value, "/nodes/01").ok, false);
  assert.equal(jsonPointerGet(value, "/toString").ok, false);
  assert.equal(jsonPointerGet(value, "nodes/0").ok, false);
  assert.equal(jsonPointerGet(value, "/nodes/5").ok, false);
  assert.equal(jsonPointerGet(value, "/nodes/0/id/x").ok, false);
  assert.equal(jsonPointerGet(value, "/missing").ok, false);
});

test("contracts compile and bind inputs and outputs", () => {
  const dir = workflowDir("bound", `
description: Contracted run.
steps:
  - id: frame
    run: steps/frame.md
    output: task-contract
  - id: investigate
    inputs:
      contract:
        from: frame
    plan:
      operators: [inspect-op]
  - id: deliver
    run: steps/deliver.md
    inputs:
      contract:
        from: frame
      findings:
        from: investigate
        select: /nodes/0/result
    output: report
`, {
    operators: { "inspect-op": "---\ndescription: Inspect.\noutput: finding\n---\nbody" },
    contracts: {
      "task-contract": { type: "object", required: ["objective"], properties: { objective: { type: "string" } } },
      finding: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
      report: { type: "object", required: ["findings"], properties: { findings: { type: "array" } } },
    },
  });
  const wf = loadWorkflowManifest(dir);
  assert.equal(wf.contracts.size, 3);
  assert.deepEqual(wf.contracts.get("task-contract").validate({ objective: "x" }), []);
  assert.ok(wf.contracts.get("task-contract").validate({}).length > 0);
  const frame = wf.root.children.find((child) => child.id === "frame");
  assert.equal(frame.output, "task-contract");
  const investigate = wf.root.children.find((child) => child.id === "investigate");
  assert.deepEqual(investigate.inputs, { contract: { from: "frame" } });
  assert.deepEqual(investigate.operators, ["inspect-op"]);
  const deliver = wf.root.children.find((child) => child.id === "deliver");
  assert.deepEqual(deliver.inputs, {
    contract: { from: "frame" },
    findings: { from: "investigate", select: "/nodes/0/result" },
  });
  assert.deepEqual(wf.inputEdges.get("investigate"), ["frame"]);
  assert.deepEqual(wf.inputEdges.get("deliver"), ["frame", "investigate"]);
  assert.equal(wf.inputEdges.has("frame"), false);
  assert.equal(wf.operators.get("inspect-op").output, "finding");
});

test("a workflow without contracts stays unchanged", () => {
  const wf = loadWorkflowManifest(workflowDir("legacy", `
description: Plain run.
steps:
  - steps/frame.md
  - steps/deliver.md
`));
  assert.equal(wf.contracts.size, 0);
  assert.equal(wf.inputEdges.size, 0);
});

test("the manifest can map contract ids to contained schema files", () => {
  const dir = workflowDir("manifest-contracts", `
description: Mapped run.
contracts:
  finding: contracts/source.schema.json
steps:
  - steps/frame.md
`, { contracts: { source: { type: "object", required: ["value"] } } });
  const wf = loadWorkflowManifest(dir);
  assert.ok(wf.contracts.has("finding"));
  assert.deepEqual(wf.contracts.get("finding").validate({ value: "ok" }), []);
});

test("bad contract files fail discovery", () => {
  const unsupported = workflowDir("unsupported", `
description: x
steps:
  - run: steps/frame.md
`, { contracts: { finding: { type: "object", patternProperties: {} } } });
  assert.throws(() => loadWorkflowManifest(unsupported), /unsupported keyword: patternProperties/);

  const invalidJson = workflowDir("badjson", `
description: x
steps:
  - run: steps/frame.md
`, { contracts: { finding: "{ not json" } });
  assert.throws(() => loadWorkflowManifest(invalidJson), /is not valid JSON/);

  const badStem = workflowDir("badstem", `
description: x
steps:
  - run: steps/frame.md
`, { contracts: { "Finding!": { type: "object" } } });
  assert.throws(() => loadWorkflowManifest(badStem), /file stem must match/);

  const oversized = workflowDir("bigschema", `
description: x
steps:
  - run: steps/frame.md
`, { contracts: { finding: { type: "object", description: "x".repeat(LIMITS.contractBytes) } } });
  assert.throws(() => loadWorkflowManifest(oversized), new RegExp(`exceeds ${LIMITS.contractBytes} bytes`));

  const tooMany = {};
  for (let i = 0; i < LIMITS.contractsCount + 1; i += 1) tooMany[`c${i}`] = { type: "object" };
  const crowded = workflowDir("crowded", `
description: x
steps:
  - run: steps/frame.md
`, { contracts: tooMany });
  assert.throws(() => loadWorkflowManifest(crowded), new RegExp(`at most ${LIMITS.contractsCount}`));
});

test("binding errors name the problem", () => {
  const forward = workflowDir("forward", `
description: x
steps:
  - id: deliver
    run: steps/deliver.md
    inputs:
      contract:
        from: frame
  - id: frame
    run: steps/frame.md
`);
  assert.throws(() => loadWorkflowManifest(forward), /from names "frame", which is not an earlier step/);

  const selfRef = workflowDir("selfref", `
description: x
steps:
  - id: frame
    run: steps/frame.md
    inputs:
      contract:
        from: frame
`);
  assert.throws(() => loadWorkflowManifest(selfRef), /from names "frame", which is not an earlier step/);

  const rootRef = workflowDir("rootref", `
description: x
steps:
  - id: frame
    run: steps/frame.md
    inputs:
      contract:
        from: root
`);
  assert.throws(() => loadWorkflowManifest(rootRef), /from names "root", which is not an earlier step/);

  const badPointer = workflowDir("badptr", `
description: x
steps:
  - id: frame
    run: steps/frame.md
  - id: deliver
    run: steps/deliver.md
    inputs:
      contract:
        from: frame
        select: nodes/0
`);
  assert.throws(() => loadWorkflowManifest(badPointer), /select must be a JSON Pointer/);

  const unknownBindingField = workflowDir("unknownfield", `
description: x
steps:
  - id: frame
    run: steps/frame.md
  - id: deliver
    run: steps/deliver.md
    inputs:
      contract:
        from: frame
        path: /nodes
`);
  assert.throws(() => loadWorkflowManifest(unknownBindingField), /path is not an accepted binding field/);

  const badName = workflowDir("badname", `
description: x
steps:
  - id: frame
    run: steps/frame.md
  - id: deliver
    run: steps/deliver.md
    inputs:
      The-Contract:
        from: frame
`);
  assert.throws(() => loadWorkflowManifest(badName), /The-Contract must match/);

  const tooManyInputs = {};
  for (let i = 0; i < LIMITS.bindingInputs + 1; i += 1) tooManyInputs[`input-${i}`] = { from: "frame" };
  const wide = workflowDir("wide", `
description: x
steps:
  - id: frame
    run: steps/frame.md
  - id: deliver
    run: steps/deliver.md
    inputs: ${JSON.stringify(tooManyInputs)}
`);
  assert.throws(() => loadWorkflowManifest(wide), new RegExp(`at most ${LIMITS.bindingInputs} entries`));
});

test("outputs must name discovered contracts", () => {
  const taskOutput = workflowDir("badoutput", `
description: x
steps:
  - run: steps/frame.md
    output: ghost-contract
`);
  assert.throws(() => loadWorkflowManifest(taskOutput), /output names contract "ghost-contract"/);

  const operatorOutput = workflowDir("badopoutput", `
description: x
steps:
  - id: p
    plan:
      operators: [inspect-op]
`, { operators: { "inspect-op": "---\ndescription: Inspect.\noutput: ghost\n---\nbody" } });
  assert.throws(() => loadWorkflowManifest(operatorOutput), /output names contract "ghost"/);

  const planOutput = workflowDir("planoutput", `
description: x
steps:
  - id: p
    plan:
      operators: [inspect-op]
    output: finding
`, {
    operators: { "inspect-op": "---\ndescription: Inspect.\n---\nbody" },
    contracts: { finding: { type: "object" } },
  });
  assert.throws(() => loadWorkflowManifest(planOutput), /output only applies to "run:" tasks/);
});
