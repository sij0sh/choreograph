import test from "node:test";
import { assert, discoverWorkflows, join, LIMITS, loadWorkflowManifest, mkdirSync, mkdtempSync, roots, symlinkSync, tmpdir, workflowDir, writeFileSync } from "./helpers.mjs";

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
  - id: deliver
    run: steps/frame.md
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
  assert.deepEqual(investigate.recovery, { maxAttempts: 2 });
  assert.equal(byId.get("deliver").recovery, undefined, "steps without repair get no recovery override");
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
  assert.throws(() => loadWorkflowManifest(unknownKey), /steps\[0\].script must be an object/);
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
  const rejected = workflowDir("rejected", `
description: x
steps:
  - run: steps/frame.md
    repair:
      max_replans: 1
      strategy: [retry]
`);
  assert.throws(() => loadWorkflowManifest(rejected), /unknown steps\[0\]\.repair key/);
  const edge = loadWorkflowManifest(workflowDir("edge", `
description: x
steps:
  - run: steps/frame.md
    repair:
      max_attempts: ${LIMITS.nodeAttempts + 1}
`));
  assert.deepEqual(edge.root.children[0].recovery, { maxAttempts: LIMITS.nodeAttempts + 1 });
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


test("script steps compile with defaults, spec fields, and recovery", () => {
  const dir = workflowDir("scripts", `
description: Script run.
contracts:
  report: contracts/report.schema.json
steps:
  - steps/frame.md
  - id: probe
    script:
      argv: [node, test.js]
      cwd: .
      env: { CI: "1" }
      inheritEnv: [PATH, HOME]
      timeoutMs: 5000
      acceptedExitCodes: [0, 2]
      stdout: json
      stderr: text
      maxCaptureBytes: 1024
    repair: { max_attempts: 1 }
    output: report
`);
  mkdirSync(join(dir, "contracts"), { recursive: true });
  writeFileSync(join(dir, "contracts", "report.schema.json"), JSON.stringify({ type: "object" }));
  const wf = loadWorkflowManifest(dir);
  const block = wf.root.children[1];
  assert.equal(block.kind, "script");
  assert.deepEqual(block.script.argv, ["node", "test.js"]);
  assert.deepEqual(block.script.env, { CI: "1" });
  assert.deepEqual(block.script.inheritEnv, ["PATH", "HOME"]);
  assert.equal(block.script.timeoutMs, 5000);
  assert.deepEqual(block.script.acceptedExitCodes, [0, 2]);
  assert.equal(block.script.stdout, "json");
  assert.equal(block.script.stderr, "text");
  assert.equal(block.script.maxCaptureBytes, 1024);
  assert.equal(block.recovery.maxAttempts, 1);
  assert.equal(block.output, "report");
});

test("script steps fill defaults for optional fields", () => {
  const dir = workflowDir("script-defaults", `
description: Defaults run.
steps:
  - id: probe
    script:
      argv: [node, test.js]
`);
  const block = loadWorkflowManifest(dir).root.children[0];
  assert.equal(block.script.cwd, ".");
  assert.equal(block.script.timeoutMs, 60_000);
  assert.deepEqual(block.script.acceptedExitCodes, [0]);
  assert.equal(block.script.stdout, "text");
  assert.equal(block.script.stderr, "none");
  assert.equal(block.script.maxCaptureBytes, 65_536);
});

test("script step rejections", () => {
  const cases = [
    ["missing-argv", `
steps:
  - id: probe
    script: { cwd: . }
`, /script.argv must be a non-empty list/],
    ["empty-argv", `
steps:
  - id: probe
    script: { argv: [] }
`, /script.argv must be a non-empty list/],
    ["bad-timeout", `
steps:
  - id: probe
    script: { argv: [node], timeoutMs: 999 }
`, /timeoutMs must be an integer between 1000 and 600000/],
    ["bad-exit-code", `
steps:
  - id: probe
    script: { argv: [node], acceptedExitCodes: [0, 256] }
`, /acceptedExitCodes\[1\] must be an integer between 0 and 255/],
    ["bad-capture-mode", `
steps:
  - id: probe
    script: { argv: [node], stdout: blob }
`, /script.stdout must be one of: json, text, none/],
    ["absolute-cwd", `
steps:
  - id: probe
    script: { argv: [node], cwd: /etc }
`, /script.cwd must be relative to the workflow directory/],
    ["escaping-cwd", `
steps:
  - id: probe
    script: { argv: [node], cwd: ../outside }
`, /script.cwd escapes the workflow directory/],
    ["mixing-run", `
steps:
  - id: probe
    run: steps/frame.md
    script: { argv: [node] }
`, /run only applies to "run:" tasks/],
    ["mixing-done", `
steps:
  - id: probe
    done: [x]
    script: { argv: [node] }
`, /done only applies to "run:" tasks/],
    ["mixing-plan", `
steps:
  - id: probe
    plan:
      operators: []
    script: { argv: [node] }
`, /declares more than one of: plan, script/],
    ["unknown-script-key", `
steps:
  - id: probe
    script: { argv: [node], shell: true }
`, /unknown steps\[0\].script key: shell/],
    ["bad-env-name", `
steps:
  - id: probe
    script: { argv: [node], env: { "1BAD": "x" } }
`, /script.env.1BAD must match/],
    ["bad-output-contract", `
steps:
  - id: probe
    script: { argv: [node] }
    output: missing-contract
`, /names contract "missing-contract", which has no contracts\/ file/],
  ];
  for (const [name, frontmatter, pattern] of cases) {
    const dir = workflowDir(name, `description: x\n${frontmatter}`);
    assert.throws(() => loadWorkflowManifest(dir), pattern, name);
  }
});


test("script files capture entries parse, reject escaping paths, and reject bad names", () => {
  const dir = workflowDir("script-files", `
description: Script run.
steps:
  - steps/frame.md
  - id: build
    script:
      argv: [node, test.js]
      files:
        - name: report
          path: out/fixture.txt
`);
  const wf = loadWorkflowManifest(dir);
  const block = wf.root.children[1];
  assert.equal(block.kind, "script");
  assert.deepEqual(block.script.files, [{ name: "report", path: "out/fixture.txt" }]);

  const escaping = workflowDir("script-files-escape", `
description: Script run.
steps:
  - steps/frame.md
  - id: build
    script:
      argv: [node, test.js]
      files:
        - name: report
          path: ../escape.txt
`);
  assert.throws(() => loadWorkflowManifest(escaping), /escapes the workflow directory/);

  const badName = workflowDir("script-files-name", `
description: Script run.
steps:
  - steps/frame.md
  - id: build
    script:
      argv: [node, test.js]
      files:
        - name: "Not A Name"
          path: out.txt
`);
  assert.throws(() => loadWorkflowManifest(badName), /files\[0\]\.name/);
});


