import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverWorkflows, loadWorkflowManifest } from "./manifest.ts";

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeWorkflow(root, name, frontmatter, files = {}) {
  const directory = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "WORKFLOW.md"), `---\n${frontmatter.trim()}\n---\n\n# ${name}\n`);
  return directory;
}

const OPERATOR = (name, frontmatter = "description: Do the thing.") => [`operators/${name}.md`, `---\n${frontmatter}\n---\n\n# ${name}\n\nDo it.\n`];

test("structured steps parse ids, kinds, tools, done, and routes", () => {
  const root = tempRoot("structured-parse-");
  const directory = writeWorkflow(
    root,
    "reasoning",
    `description: Bounded reasoning.
steps:
  - path: steps/01-frame.md
  - path: steps/02-observe.md
    id: observe
    tools: [read]
  - path: steps/03-plan.md
    kind: planner
    done: [plan-present]
  - path: steps/04-execute.md
    kind: executor
    on:
      rework: observe
  - path: steps/05-verify.md
    id: verify
    on:
      pass: deliver
      rework: execute
      replan: plan
  - path: steps/06-deliver.md`,
    Object.fromEntries(
      ["steps/01-frame.md", "steps/02-observe.md", "steps/03-plan.md", "steps/04-execute.md", "steps/05-verify.md", "steps/06-deliver.md", "operators/inspect.md"].map((file) => [
        file,
        file.endsWith("operators/inspect.md") ? "---\ndescription: Inspect.\n---\n\n# Inspect\n" : `# ${file}\n`,
      ]),
    ),
  );
  const descriptor = loadWorkflowManifest(directory);
  assert.equal(descriptor.structured, true);
  assert.deepEqual(
    descriptor.steps.map((step) => [step.id, step.kind]),
    [
      ["frame", "static"],
      ["observe", "static"],
      ["plan", "planner"],
      ["execute", "executor"],
      ["verify", "static"],
      ["deliver", "static"],
    ],
  );
  assert.deepEqual([...descriptor.steps[1].tools], ["read"]);
  assert.deepEqual(descriptor.steps[2].done, ["plan-present"]);
  assert.deepEqual(descriptor.steps[4].on, { pass: "deliver", rework: "execute", replan: "plan" });
  assert.equal(descriptor.operators.size, 1);
  assert.equal(descriptor.tools, undefined);
});

test("a planner step requires at least one operator", () => {
  const root = tempRoot("structured-operators-required-");
  const directory = writeWorkflow(
    root,
    "no-operators",
    `description: Missing operators.
steps:
  - path: steps/01-plan.md
    kind: planner
  - path: steps/02-execute.md
    kind: executor`,
    { "steps/01-plan.md": "# step\n", "steps/02-execute.md": "# step\n" },
  );
  assert.throws(() => loadWorkflowManifest(directory), /at least one operator/);
});

test("operators load with descriptions, tools, and validated ids", () => {
  const root = tempRoot("structured-operators-");
  const directory = writeWorkflow(
    root,
    "reasoning",
    `description: Has operators.
steps:
  - path: steps/01-plan.md
    kind: planner
  - path: steps/02-execute.md
    kind: executor`,
    {
      "steps/01-plan.md": "# plan\n",
      "steps/02-execute.md": "# execute\n",
      "operators/inspect.md": "---\ndescription: Inspect the surface.\ntools: [read, bash]\n---\n\n# Inspect\n",
      "operators/trace.md": "---\ndescription: Trace flow.\n---\n\n# Trace\n",
    },
  );
  const descriptor = loadWorkflowManifest(directory);
  assert.deepEqual([...descriptor.operators.keys()], ["inspect", "trace"]);
  assert.equal(descriptor.operators.get("inspect").description, "Inspect the surface.");
  assert.deepEqual([...descriptor.operators.get("inspect").tools], ["read", "bash"]);
  assert.equal(descriptor.operators.get("trace").tools, undefined);
  assert.match(descriptor.operators.get("inspect").path, /operators\/inspect\.md$/);
});

test("operator frontmatter rejects unknown keys, missing descriptions, and bad tool lists", () => {
  const root = tempRoot("structured-operator-bad-");
  const base = { "steps/01-plan.md": "# p\n", "steps/02-execute.md": "# e\n", "operators/inspect.md": "" };
  const cases = [
    ["---\ndescription: Inspect.\nprompt: nope\n---\n", /unknown operators\/inspect.md frontmatter key: prompt/],
    ["---\ntools: [read]\n---\n", /description must be a non-empty string/],
    ["---\ndescription: Inspect.\ntools: [Read]\n---\n", /must match/],
    ["---\ndescription: Inspect.\ntools: [read, read]\n---\n", /must not contain duplicates/],
    ["# no frontmatter\n", /must start with frontmatter/],
  ];
  for (const [body, pattern] of cases) {
    const directory = writeWorkflow(
      root,
      "reasoning",
      `description: Bad operators.\nsteps:\n  - path: steps/01-plan.md\n    kind: planner\n  - path: steps/02-execute.md\n    kind: executor`,
      { ...base, "operators/inspect.md": body },
    );
    assert.throws(() => loadWorkflowManifest(directory), pattern, body);
  }
});

test("operator file stems must be valid ids and files are size-bounded", () => {
  const root = tempRoot("structured-operator-stem-");
  const frontmatter = `description: Bad stem.\nsteps:\n  - path: steps/01-plan.md\n    kind: planner\n  - path: steps/02-execute.md\n    kind: executor`;
  const steps = { "steps/01-plan.md": "# p\n", "steps/02-execute.md": "# e\n" };
  const bad = writeWorkflow(root, "bad-stem", frontmatter, { ...steps, "operators/Not_Valid.md": "---\ndescription: x\n---\n" });
  assert.throws(() => loadWorkflowManifest(bad), /operators\/Not_Valid.md file stem must match/);

  const huge = writeWorkflow(root, "huge-operator", frontmatter, steps);
  mkdirSync(join(huge, "operators"));
  writeFileSync(join(huge, "operators", "inspect.md"), `---\ndescription: x\n---\n\n${"x".repeat(128_001)}`);
  assert.throws(() => loadWorkflowManifest(huge), /exceeds 128000 bytes/);
});

test("operator symlinks may not escape the workflow directory", () => {
  const root = tempRoot("structured-operator-symlink-");
  const outside = join(root, "outside.md");
  writeFileSync(outside, "---\ndescription: Escaped.\n---\n");
  const directory = writeWorkflow(
    root,
    "reasoning",
    `description: Symlink escape.\nsteps:\n  - path: steps/01-plan.md\n    kind: planner\n  - path: steps/02-execute.md\n    kind: executor`,
    { "steps/01-plan.md": "# p\n", "steps/02-execute.md": "# e\n" },
  );
  mkdirSync(join(directory, "operators"));
  symlinkSync(outside, join(directory, "operators", "inspect.md"));
  assert.throws(() => loadWorkflowManifest(directory), /escapes the workflow directory/);
});

test("structured steps reject unknown keys, kinds, criteria, and route targets", () => {
  const root = tempRoot("structured-bad-");
  const steps = { "steps/01-plan.md": "# p\n", "steps/02-execute.md": "# e\n" };
  const cases = [
    ["    prompt: nope", /unknown steps\[0\] key: prompt/],
    ["    kind: verifier", /kind must be planner or executor/],
    ["    id: Verify", /steps\[0\].id must match/],
    ["    done: []", /done must be a non-empty list/],
    ["    done: [plan, plan]", /must not contain duplicates/],
    ["    done: [Bad ID]", /done\[0\] must match/],
    ["    on:\n      pass: ghost", /targets unknown step id: ghost/],
    ["    on:\n      rework: 3", /steps\[0\].on.rework must be a non-empty string/],
  ];
  for (const [fragment, pattern] of cases) {
    const directory = writeWorkflow(
      root,
      "reasoning",
      `description: Bad steps.\nsteps:\n  - path: steps/01-plan.md\n${fragment}\n  - path: steps/02-execute.md`,
      steps,
    );
    assert.throws(() => loadWorkflowManifest(directory), pattern, fragment);
  }
});

test("derived ids must be valid in structured workflows", () => {
  const root = tempRoot("structured-derived-id-");
  const directory = writeWorkflow(
    root,
    "reasoning",
    `description: Bad derived id.\nsteps:\n  - path: steps/01-bad_id.md\n  - path: steps/02-two.md`,
    { "steps/01-bad_id.md": "# p\n", "steps/02-two.md": "# e\n" },
  );
  assert.throws(() => loadWorkflowManifest(directory), /set an explicit id for "bad_id"/);
});

test("planner and executor must be paired and ordered", () => {
  const root = tempRoot("structured-pairing-");
  const steps = { "steps/01-plan.md": "# p\n", "steps/02-execute.md": "# e\n", "steps/03-schemer.md": "# p\n" };
  const cases = [
    [`steps:\n  - path: steps/01-plan.md\n    kind: planner`, /exactly one executor/],
    [`steps:\n  - path: steps/02-execute.md\n    kind: executor`, /exactly one planner/],
    [
      `steps:\n  - path: steps/02-execute.md\n    kind: executor\n  - path: steps/03-schemer.md\n    kind: planner`,
      /executor step must come after the planner step/,
    ],
    [
      `steps:\n  - path: steps/01-plan.md\n    kind: planner\n  - path: steps/03-schemer.md\n    kind: planner`,
      /exactly one planner/,
    ],
  ];
  for (const [stepsYaml, pattern] of cases) {
    const directory = writeWorkflow(root, "reasoning", `description: Pairing.\n${stepsYaml}`, steps);
    assert.throws(() => loadWorkflowManifest(directory), pattern, stepsYaml);
  }
});

test("duplicate step ids are rejected in structured and legacy workflows", () => {
  const root = tempRoot("structured-dup-ids-");
  const structured = writeWorkflow(
    root,
    "dup-explicit",
    `description: Dup.\nsteps:\n  - path: steps/01-a.md\n    id: same\n  - path: steps/02-b.md\n    id: same`,
    { "steps/01-a.md": "# a\n", "steps/02-b.md": "# b\n" },
  );
  assert.throws(() => loadWorkflowManifest(structured), /step ids must not contain duplicates/);
  const legacy = writeWorkflow(
    root,
    "dup-derived",
    `description: Dup.\nsteps:\n  - steps/01-a.md\n  - steps/02-a.md`,
    { "steps/01-a.md": "# a\n", "steps/02-a.md": "# b\n" },
  );
  assert.throws(() => loadWorkflowManifest(legacy), /step ids must not contain duplicates/);
});

test("tools is the primary key and legalTools stays a legacy alias", () => {
  const root = tempRoot("tools-alias-");
  const steps = { "steps/01-a.md": "# a\n" };
  const both = writeWorkflow(root, "both", `description: Both.\ntools: [read]\nlegalTools: [bash]\nsteps:\n  - steps/01-a.md`, steps);
  assert.throws(() => loadWorkflowManifest(both), /aliases; configure only one/);
  const tools = loadWorkflowManifest(writeWorkflow(root, "tools", `description: Tools.\ntools: [read]\nsteps:\n  - steps/01-a.md`, steps));
  assert.deepEqual([...tools.tools], ["read"]);
  const alias = loadWorkflowManifest(writeWorkflow(root, "alias", `description: Alias.\nlegalTools: [bash]\nsteps:\n  - steps/01-a.md`, steps));
  assert.deepEqual([...alias.tools], ["bash"]);
  const empty = loadWorkflowManifest(writeWorkflow(root, "empty", `description: Empty.\ntools: []\nsteps:\n  - steps/01-a.md`, steps));
  assert.deepEqual([...empty.tools], []);
  const legacy = loadWorkflowManifest(writeWorkflow(root, "legacy", `description: Legacy.\nsteps:\n  - steps/01-a.md`, steps));
  assert.equal(legacy.structured, false);
  assert.equal(legacy.tools, undefined);
  assert.equal(legacy.steps[0].kind, "static");
  assert.equal(legacy.steps[0].id, "a");
});

test("model selectors parse at both levels and reject malformed shapes", () => {
  const root = tempRoot("model-selector-");
  const steps = { "steps/01-a.md": "# a\n", "steps/02-b.md": "# b\n" };
  const good = loadWorkflowManifest(
    writeWorkflow(root, "good", `description: Models.\nmodel: provider/model-id\nsteps:\n  - path: steps/01-a.md\n    model: other/m2\n  - steps/02-b.md`, steps),
  );
  assert.equal(good.model, "provider/model-id");
  assert.equal(good.steps[0].model, "other/m2");
  assert.equal(good.steps[1].model, undefined);
  for (const [selector, pattern] of [
    ["bare-model", /must be a provider\/model-id selector/],
    ["/leading", /must be a provider\/model-id selector/],
    ["trailing/", /must be a provider\/model-id selector/],
    ["a/b/c", /must be a provider\/model-id selector/],
    ["", /must be a non-empty string/],
  ]) {
    const directory = writeWorkflow(root, "bad", `description: Bad.\nmodel: ${selector}\nsteps:\n  - steps/01-a.md`, steps);
    assert.throws(() => loadWorkflowManifest(directory), pattern, selector);
    const stepLevel = writeWorkflow(root, "bad-step", `description: Bad.\nsteps:\n  - path: steps/01-a.md\n    model: ${selector}\n  - steps/02-b.md`, steps);
    assert.throws(() => loadWorkflowManifest(stepLevel), pattern, selector);
  }
});

test("discovery isolates invalid structured workflows", () => {
  const root = tempRoot("structured-discovery-");
  writeWorkflow(root, "good-one", `description: Fine.\nsteps:\n  - steps/01-a.md`, { "steps/01-a.md": "# a\n" });
  const bad = writeWorkflow(
    root,
    "bad-routes",
    `description: Bad.\nsteps:\n  - path: steps/01-a.md\n    on:\n      pass: ghost`,
    { "steps/01-a.md": "# a\n" },
  );
  const result = discoverWorkflows(root);
  assert.deepEqual(result.workflows.map((item) => item.name), ["good-one"]);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].error, /targets unknown step id: ghost/);
  assert.equal(result.diagnostics[0].path, join(bad, "WORKFLOW.md"));
});
