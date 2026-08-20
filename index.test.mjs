import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import register from "./index.ts";
import { discoverWorkflows, loadWorkflowManifest } from "./manifest.ts";

const RUN_TOOLS = ["workflow_advance", "workflow_abort"];
const START_TOOL = "workflow_start";

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeWorkflow(root, name, options = {}) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const stepFiles = options.stepFiles ?? ["steps/01-one.md", "steps/02-two.md"];
  for (const file of stepFiles) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), `# ${file}\n`);
  }
  const frontmatter = [
    "---",
    `description: ${name} description`,
    "steps:",
    ...stepFiles.map((file) => `  - ${file}`),
  ];
  if (options.legalTools !== undefined) {
    if (options.legalTools.length === 0) {
      frontmatter.push("legalTools: []");
    } else {
      frontmatter.push("legalTools:");
      for (const tool of options.legalTools) frontmatter.push(`  - ${tool}`);
    }
  }
  if (options.piVisibility !== undefined) frontmatter.push(`piVisibility: ${options.piVisibility}`);
  frontmatter.push("---", "");
  writeFileSync(join(directory, "WORKFLOW.md"), frontmatter.join("\n"));
  return directory;
}

function manifestText(directory) {
  return readFileSync(join(directory, "WORKFLOW.md"), "utf8");
}

function rewriteManifest(directory, text) {
  writeFileSync(join(directory, "WORKFLOW.md"), text);
}

function harness(root, entries = []) {
  const activeTools = new Set(["read", "bash"]);
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const sent = [];
  const attempts = [];
  const notices = [];
  const statuses = [];
  let streaming = false;
  let appendFailure = null;
  let sendFailure = null;
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    },
    sendUserMessage: (message, options) => {
      attempts.push({ message, options });
      if (sendFailure) throw new Error(sendFailure);
      sent.push({ message, options });
    },
    appendEntry: (customType, data) => {
      if (appendFailure) throw new Error(appendFailure);
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    cwd: "/repo",
    sessionManager: { getBranch: () => [...entries] },
    isIdle: () => !streaming,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };
  register(pi, root);
  return { activeTools, attempts, commands, ctx, entries, handlers, notices, pi, sent, setAppendFailure: (message) => (appendFailure = message), setSendFailure: (message) => (sendFailure = message), setStreaming: (value) => (streaming = value), statuses, tools };
}

async function startRun(run, name = "auditable", target = "") {
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  await run.commands.get(name).handler(target, run.ctx);
}

async function endRun(run) {
  await run.handlers.get("agent_settled")({ type: "agent_settled" }, run.ctx);
}

test("manifest derives name, title, labels, and visibility from the directory", () => {
  const root = tempRoot("workflow-manifest-");
  const directory = writeWorkflow(root, "derived-name", { stepFiles: ["steps/01-surface.md", "steps/02-report.md"] });
  const descriptor = loadWorkflowManifest(directory);
  assert.equal(descriptor.name, "derived-name");
  assert.equal(descriptor.title, "Derived Name");
  assert.equal(descriptor.overviewPath, join(directory, "WORKFLOW.md"));
  assert.equal(descriptor.steps.length, 2);
  assert.deepEqual(
    descriptor.steps.map((step) => step.label),
    ["surface", "report"],
  );
  assert.equal(descriptor.steps[0].path, join(directory, "steps/01-surface.md"));
  assert.equal(descriptor.piVisibility, false);
  assert.equal(descriptor.legalTools, undefined);
});

test("workflow names reject repeated and trailing hyphens", () => {
  const root = tempRoot("workflow-name-slugs-");
  for (const name of ["foo--bar", "foo-"]) {
    const directory = writeWorkflow(root, name);
    assert.throws(() => loadWorkflowManifest(directory), /workflow directory name/);
  }
});

test("step labels require a leading numeric prefix", () => {
  const root = tempRoot("workflow-step-labels-");
  const directory = writeWorkflow(root, "labeled", { stepFiles: ["steps/01-surface.md", "steps/phase-01-review.md", "steps/handoff.md"] });
  const descriptor = loadWorkflowManifest(directory);
  assert.deepEqual(
    descriptor.steps.map((step) => step.label),
    ["surface", "phase-01-review", "handoff"],
  );
});

test("oversized step files are rejected", () => {
  const root = tempRoot("workflow-step-size-");
  const directory = writeWorkflow(root, "huge", { stepFiles: ["steps/01-big.md"] });
  writeFileSync(join(directory, "steps/01-big.md"), "x".repeat(128_001));
  assert.throws(() => loadWorkflowManifest(directory), /steps\[0\] exceeds 128000 bytes/);
});

test("names beginning with two dots stay contained", () => {
  const root = tempRoot("workflow-containment-");
  const directory = writeWorkflow(root, "dotted", { stepFiles: ["..hidden/01-step.md"] });
  const descriptor = loadWorkflowManifest(directory);
  assert.equal(descriptor.steps[0].path, join(directory, "..hidden/01-step.md"));
});

test("title frontmatter is rejected in favor of the derived title", () => {
  const root = tempRoot("workflow-title-");
  const directory = writeWorkflow(root, "custom-name");
  rewriteManifest(directory, manifestText(directory).replace("---\n", "---\ntitle: Custom API Audit\n"));
  assert.throws(() => loadWorkflowManifest(directory), /unknown frontmatter key: title/);
});

test("steps must be a non-empty list of contained markdown files", () => {
  const root = tempRoot("workflow-steps-");
  const escape = writeWorkflow(root, "escape", { stepFiles: ["steps/one.md"] });
  rewriteManifest(escape, manifestText(escape).replace("- steps/one.md", "- ../outside.md"));
  assert.throws(() => loadWorkflowManifest(escape), /escapes the workflow directory/);
  const absolute = writeWorkflow(root, "absolute", { stepFiles: ["steps/one.md"] });
  rewriteManifest(absolute, manifestText(absolute).replace("- steps/one.md", "- /etc/hosts.md"));
  assert.throws(() => loadWorkflowManifest(absolute), /must be relative/);
  const badExtension = writeWorkflow(root, "scripty", { stepFiles: ["steps/one.md"] });
  rewriteManifest(badExtension, manifestText(badExtension).replace("- steps/one.md", "- scripts/run.py"));
  assert.throws(() => loadWorkflowManifest(badExtension), /must be a Markdown \(\.md\) file/);
  const empty = writeWorkflow(root, "empty", { stepFiles: ["steps/one.md"] });
  rewriteManifest(empty, manifestText(empty).replace("steps:\n  - steps/one.md", "steps: []"));
  assert.throws(() => loadWorkflowManifest(empty), /steps must be a non-empty list/);
  const duplicates = writeWorkflow(root, "dupes");
  rewriteManifest(duplicates, manifestText(duplicates).replace("- steps/02-two.md", "- steps/01-one.md"));
  assert.throws(() => loadWorkflowManifest(duplicates), /must not contain duplicates/);
});

test("obsolete frontmatter keys are rejected", () => {
  const root = tempRoot("workflow-obsolete-");
  for (const key of ["name", "title", "enabled", "phases", "autoAdvance", "compact", "onAdvance", "afterStep"]) {
    const directory = writeWorkflow(root, `obsolete-${key}`);
    rewriteManifest(directory, manifestText(directory).replace("---\n", `---\n${key}: true\n`));
    assert.throws(() => loadWorkflowManifest(directory), new RegExp(`unknown frontmatter key: ${key}`));
  }
});

test("legalTools frontmatter is parsed, deduped, and validated", () => {
  const root = tempRoot("workflow-legaltools-");
  const gated = loadWorkflowManifest(writeWorkflow(root, "gated", { legalTools: ["bash", "read"] }));
  assert.deepEqual([...gated.legalTools].sort(), ["bash", "read"]);
  const empty = loadWorkflowManifest(writeWorkflow(root, "empty-legal", { legalTools: [] }));
  assert.deepEqual([...empty.legalTools], []);
  assert.equal(loadWorkflowManifest(writeWorkflow(root, "open")).legalTools, undefined);
  assert.throws(() => loadWorkflowManifest(writeWorkflow(root, "bad", { legalTools: ["Read"] })), /legalTools\[0\] must match/);
  assert.throws(() => loadWorkflowManifest(writeWorkflow(root, "dupes", { legalTools: ["read", "read"] })), /must not contain duplicates/);
});

test("piVisibility frontmatter is validated and defaults to false", () => {
  const root = tempRoot("workflow-flags-");
  assert.equal(loadWorkflowManifest(writeWorkflow(root, "default-hidden")).piVisibility, false);
  assert.equal(loadWorkflowManifest(writeWorkflow(root, "exposed", { piVisibility: true })).piVisibility, true);
  assert.equal(loadWorkflowManifest(writeWorkflow(root, "hidden", { piVisibility: false })).piVisibility, false);
  assert.throws(() => loadWorkflowManifest(writeWorkflow(root, "bad-visibility", { piVisibility: "yes" })), /piVisibility must be a boolean/);
});

test("discovery isolates invalid metadata and skips directories without WORKFLOW.md", () => {
  const root = tempRoot("workflow-discovery-");
  writeWorkflow(root, "gamma");
  const unmarked = join(root, "unmarked");
  mkdirSync(unmarked);
  writeFileSync(join(unmarked, "notes.txt"), "scratch\n");
  const invalid = join(root, "broken");
  mkdirSync(invalid);
  writeFileSync(join(invalid, "WORKFLOW.md"), "---\ndescription: broken\n---\n");
  const misnamed = writeWorkflow(root, "NotValid");
  const result = discoverWorkflows(root);
  assert.deepEqual(result.workflows.map((item) => item.name), ["gamma"]);
  assert.equal(result.diagnostics.length, 2);
  assert.match(result.diagnostics.map((item) => item.error).join(" "), /steps must be a non-empty list/);
  assert.match(result.diagnostics.map((item) => item.error).join(" "), /workflow directory name must match/);
  assert.ok(misnamed);
});

test("discovery treats an absent root as an empty installation", () => {
  const absent = join(tmpdir(), `workflow-absent-${process.pid}-${Date.now()}`);
  const result = discoverWorkflows(absent);
  assert.deepEqual(result.workflows, []);
  assert.deepEqual(result.diagnostics, []);
});

test("extension registration succeeds with an absent workflows root", () => {
  const absent = join(tmpdir(), `workflow-absent-registration-${process.pid}-${Date.now()}`);
  const run = harness(absent);
  assert.equal(run.commands.size, 0);
  assert.equal(run.tools.has(START_TOOL), false);
  run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  assert.equal(run.notices.length, 0);
  assert.ok(run.activeTools.has("read"));
  assert.ok(run.activeTools.has("bash"));
});

test("discovery reports a failed root as one root diagnostic that preserves the path", () => {
  const root = tempRoot("workflow-root-failed-");
  const notADirectory = join(root, "not-a-directory");
  writeFileSync(notADirectory, "content\n");
  const result = discoverWorkflows(notADirectory);
  assert.deepEqual(result.workflows, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, notADirectory);
  assert.match(result.diagnostics[0].error, /ENOTDIR/);
});

test("discovery lets non-filesystem root errors escape", () => {
  assert.throws(() => discoverWorkflows(join("root\0invalid", "child")), TypeError);
});

test("registration exposes commands and workflow tools", async () => {
  const root = tempRoot("workflow-register-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  assert.deepEqual([...run.commands.keys()], ["auditable"]);
  assert.deepEqual([...run.tools.keys()].sort(), [...RUN_TOOLS, START_TOOL].sort());
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  assert.ok(run.activeTools.has(START_TOOL));
  for (const name of RUN_TOOLS) assert.ok(!run.activeTools.has(name), name);
});

test("workflow_start tool description and enum list only visible workflows", async () => {
  const root = tempRoot("workflow-toolnames-");
  writeWorkflow(root, "alpha", { piVisibility: true });
  writeWorkflow(root, "bravo", { piVisibility: false });
  const run = harness(root);
  const tool = run.tools.get(START_TOOL);
  assert.match(tool.description, /alpha/);
  assert.doesNotMatch(tool.description, /bravo/);
  assert.deepEqual(tool.parameters.properties.name.enum, ["alpha"]);
  const result = await tool.execute("call", { name: "bravo" }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown workflow: bravo/);
});

test("idle prompt describes visible workflows and omits hidden ones", async () => {
  const root = tempRoot("workflow-roster-");
  writeWorkflow(root, "shown", { piVisibility: true });
  writeWorkflow(root, "hidden", { piVisibility: false });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  const result = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(result.systemPrompt, /# Available workflows/);
  assert.match(result.systemPrompt, /`shown`: shown description/);
  assert.doesNotMatch(result.systemPrompt, /hidden description/);
});

test("hidden-by-default setups keep slash commands but skip workflow_start and the roster", async () => {
  const root = tempRoot("workflow-roster-empty-");
  writeWorkflow(root, "secret");
  const run = harness(root);
  assert.ok(run.commands.has("secret"));
  assert.ok(!run.tools.has(START_TOOL));
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  assert.ok(!run.activeTools.has(START_TOOL));
  for (const name of RUN_TOOLS) assert.ok(!run.activeTools.has(name), name);
  assert.equal(await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx), undefined);
});

test("hidden workflows stay user-startable via slash command", async () => {
  const root = tempRoot("workflow-hidden-slash-");
  writeWorkflow(root, "secret");
  const run = harness(root);
  await startRun(run, "secret");
  for (const name of RUN_TOOLS) assert.ok(run.activeTools.has(name), name);
  assert.match(run.sent.at(-1).message, /step 1 \(one\)/);
});

test("starting a run swaps in run tools and injects step 1 context", async () => {
  const root = tempRoot("workflow-start-");
  writeWorkflow(root, "auditable");
  const run = harness(root);
  run.activeTools.add("git_record");
  await startRun(run, "auditable", "agent/extensions");

  assert.ok(!run.activeTools.has(START_TOOL));
  assert.deepEqual(RUN_TOOLS.filter((name) => run.activeTools.has(name)), RUN_TOOLS);
  assert.ok(run.activeTools.has("read"));
  assert.ok(run.activeTools.has("bash"));
  assert.match(run.sent.at(-1).message, /step 1 \(one\)/);
  assert.match(run.sent.at(-1).message, /Target: agent\/extensions/);
  assert.deepEqual(run.sent.at(-1).options, { deliverAs: "followUp" });

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /^base/);
  assert.match(prompt.systemPrompt, /# Active workflow/);
  assert.match(prompt.systemPrompt, /Step: 1\/2 \(step 1 \(one\)\)/);
  assert.match(prompt.systemPrompt, /# steps\/01-one\.md/);
});

test("legalTools gates baseline tools during a run and restores them on abort", async () => {
  const root = tempRoot("workflow-gate-");
  writeWorkflow(root, "gated", { legalTools: ["read"], piVisibility: true });
  const run = harness(root);
  run.activeTools.add("git_record");
  await startRun(run, "gated");
  assert.ok(!run.activeTools.has("git_record"));
  assert.ok(run.activeTools.has("read"));
  assert.ok(!run.activeTools.has("bash"));
  for (const name of RUN_TOOLS) assert.ok(run.activeTools.has(name), name);

  await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);
  assert.ok(run.activeTools.has("git_record"));
  assert.ok(!run.activeTools.has("workflow_abort"));
  assert.ok(run.activeTools.has(START_TOOL));
});

test("legalTools: [] restricts a run to exactly the workflow run tools", async () => {
  const root = tempRoot("workflow-legaltools-empty-");
  writeWorkflow(root, "auditable", { legalTools: [], piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  assert.ok(!run.notices.some((item) => /legalTools/.test(item.message)));
  const idle = [...run.activeTools].sort();
  assert.ok(idle.includes("read") && idle.includes("bash"));
  await run.commands.get("auditable").handler("", run.ctx);
  assert.deepEqual([...run.activeTools].sort(), [...RUN_TOOLS].sort());
  await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);
  assert.deepEqual([...run.activeTools].sort(), idle);
});

test("unknown legalTools entries produce a session-start warning", async () => {
  const root = tempRoot("workflow-legaltools-warning-");
  writeWorkflow(root, "gated", { legalTools: ["read", "nonexistent"], piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  const warning = run.notices.find((item) => /legalTools/.test(item.message));
  assert.ok(warning);
  assert.equal(warning.level, "warning");
  assert.match(warning.message, /gated: nonexistent/);
});

test("final advance completes the workflow and restores idle tools", async () => {
  const root = tempRoot("workflow-final-");
  writeWorkflow(root, "single", { stepFiles: ["steps/01-only.md"], piVisibility: true });
  const run = harness(root);
  await startRun(run, "single");

  const result = await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  assert.equal(result.details.status, "completed");
  assert.ok(!run.activeTools.has("workflow_advance"));
  assert.ok(run.activeTools.has(START_TOOL));
  assert.equal(run.sent.length, 2);
  await endRun(run);
  assert.equal(run.sent.length, 2);
  assert.match(run.sent.at(-1).message, /complete/);
  assert.deepEqual(run.sent.at(-1).options, { deliverAs: "followUp" });
});

test("workflow_start tool refuses to start while a run is active", async () => {
  const root = tempRoot("workflow-busy-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await startRun(run, "auditable");
  const result = await run.tools.get(START_TOOL).execute("call", { name: "auditable" }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already active/);
  assert.equal(run.sent.filter((item) => /Start /.test(item.message)).length, 1);
});

test("run tools fail without an active run", async () => {
  const root = tempRoot("workflow-idle-");
  writeWorkflow(root, "auditable");
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  await assert.rejects(() => run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx), /no active workflow/);
  await assert.rejects(() => run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx), /no active workflow/);
});

test("accepted follow-ups permit each delivered step to advance", async () => {
  const root = tempRoot("workflow-runaway-");
  writeWorkflow(root, "auditable", { stepFiles: ["steps/01-one.md", "steps/02-two.md"] });
  const run = harness(root);
  await startRun(run, "auditable");
  assert.equal(run.sent.length, 1);

  await run.tools.get("workflow_advance").execute("call-1", {}, undefined, undefined, run.ctx);
  await run.tools.get("workflow_advance").execute("call-2", {}, undefined, undefined, run.ctx);
  assert.equal(run.sent.length, 3);
  assert.match(run.sent.at(-1).message, /complete: all 2 steps advanced/);

  await endRun(run);
  assert.equal(run.sent.length, 3);
});

test("workflow_start delegates streaming delivery to the native follow-up queue", async () => {
  const root = tempRoot("workflow-tool-start-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);

  run.setStreaming(true);
  const result = await run.tools.get(START_TOOL).execute("call", { name: "auditable", target: "pi" }, undefined, undefined, run.ctx);
  assert.equal(result.terminate, true);
  assert.match(result.content[0].text, /arrives next/);
  assert.equal(run.sent.length, 1);

  run.setStreaming(false);
  await endRun(run);
  assert.equal(run.sent.length, 1);
  assert.match(run.sent.at(-1).message, /Start Auditable run/);
  assert.match(run.sent.at(-1).message, /Target: pi/);
  assert.match(run.sent.at(-1).message, /# steps\/01-one\.md/);
});

test("workflow transitions append resumable snapshots", async () => {
  const root = tempRoot("workflow-persist-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await startRun(run, "auditable");
  const started = run.entries.at(-2);
  assert.equal(started.customType, "pi-workflows");
  assert.equal(started.data.status, "active");
  assert.equal(started.data.workflow, "auditable");
  assert.equal(started.data.step, 1);
  assert.equal(started.data.delivered, false, "state commits before its delivery marker");
  const kickoff = run.entries.at(-1);
  assert.equal(kickoff.data.status, "active");
  assert.equal(kickoff.data.delivered, true, "accepted kickoff commits its marker");

  await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  const advance = run.entries.at(-2);
  assert.equal(advance.data.status, "active");
  assert.equal(advance.data.step, 2);
  assert.equal(advance.data.delivered, false, "step 2 commits before delivery");
  assert.equal(advance.data.runId, started.data.runId);

  const marker = run.entries.at(-1);
  assert.equal(marker.data.status, "active");
  assert.equal(marker.data.step, 2);
  assert.equal(marker.data.delivered, true, "delivered marker commits after accepted delivery");

  await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);
  assert.deepEqual(run.entries.at(-1).data, { v: 2, status: "aborted" });
});

test("session resume restores an active run with tools, status, and step context", async () => {
  const root = tempRoot("workflow-resume-active-");
  writeWorkflow(root, "gated", { legalTools: ["read"], piVisibility: true });
  const first = harness(root);
  await startRun(first, "gated", "pi");
  await first.tools.get("workflow_advance").execute("call", {}, undefined, undefined, first.ctx);
  await endRun(first);

  const run = harness(root, first.entries);
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  for (const name of RUN_TOOLS) assert.ok(run.activeTools.has(name), name);
  assert.ok(run.activeTools.has("read"));
  assert.ok(!run.activeTools.has("bash"));
  assert.ok(!run.activeTools.has(START_TOOL));
  assert.deepEqual(run.statuses.at(-1), { key: "pi-workflows", value: "gated 2/2" });
  const notice = run.notices.find((item) => /Resumed Gated run/.test(item.message));
  assert.ok(notice);
  assert.equal(notice.level, "info");

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /# Active workflow/);
  assert.match(prompt.systemPrompt, /Step: 2\/2/);

  assert.equal(first.sent.length, 2);
  assert.match(first.sent.at(-1).message, /Continue Gated run/);
  assert.match(first.sent.at(-1).message, /step 2/);

  await endRun(run);
  assert.equal(run.sent.length, 0, "a durable delivered marker suppresses duplicate delivery");
});

test("session resume restores a run still on step 1", async () => {
  const root = tempRoot("workflow-resume-first-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const first = harness(root);
  await startRun(first, "auditable");

  const run = harness(root, first.entries);
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.activeTools.has("workflow_advance"));
  assert.deepEqual(run.statuses.at(-1), { key: "pi-workflows", value: "auditable 1/2" });
  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /# Active workflow/);
  assert.match(prompt.systemPrompt, /Step: 1\/2/);
});

test("session resume rejects invalid active-step domain values", async () => {
  const root = tempRoot("workflow-resume-domain-");
  writeWorkflow(root, "gated", { legalTools: ["read"], piVisibility: true });
  const run = harness(root);

  for (const step of [1.5, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    run.entries.length = 0;
    run.entries.push({ type: "custom", customType: "pi-workflows", data: { v: 1, status: "active", workflow: "gated", runId: "r-domain", step, target: "", deliveredStep: 1 } });
    await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
    assert.ok(!run.activeTools.has("workflow_advance"), `step ${step} must not resume`);
    assert.ok(!run.activeTools.has("workflow_abort"), `step ${step} must not resume`);
    assert.equal(run.statuses.some((item) => item.key === "pi-workflows" && item.value !== undefined), false, `step ${step} must not set status`);
    assert.equal(run.notices.some((item) => /Resumed Gated run/.test(item.message)), false, `step ${step} must not announce resume`);
  }

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.doesNotMatch(prompt.systemPrompt, /# Active workflow/);
  assert.doesNotMatch(prompt.systemPrompt, /undefined/);
});

test("session resume drops stale runs and stays idle after abort or corrupt snapshots", async () => {
  const root = tempRoot("workflow-resume-drop-");
  writeWorkflow(root, "gated", { legalTools: ["read"], piVisibility: true });
  const run = harness(root);
  const snapshot = (data) => run.entries.push({ type: "custom", customType: "pi-workflows", data });

  snapshot({ v: 1, status: "active", workflow: "ghost", runId: "r1", step: 1, target: "", deliveredStep: 1 });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.notices.some((item) => item.level === "warning" && /ghost run: that workflow no longer exists/.test(item.message)));
  for (const name of RUN_TOOLS) assert.ok(!run.activeTools.has(name), name);

  snapshot({ v: 1, status: "active", workflow: "gated", runId: "r2", step: 5, target: "", deliveredStep: 4 });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.notices.some((item) => item.level === "warning" && /step 5 of 2 no longer exists/.test(item.message)));
  assert.ok(!run.activeTools.has("workflow_advance"));

  snapshot({ v: 1, status: "aborted" });
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.equal(run.notices.filter((item) => /Resumed/.test(item.message)).length, 0);

  snapshot("corrupt");
  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  assert.ok(run.activeTools.has(START_TOOL));
  for (const name of RUN_TOOLS) assert.ok(!run.activeTools.has(name), name);
});

// --- cancellation ---

test("an aborted signal rejects an advance and keeps the prior step", async () => {
  const root = tempRoot("workflow-cancel-advance-");
  writeWorkflow(root, "cancel-advance");
  const run = harness(root);
  await startRun(run, "cancel-advance");
  const entryCount = run.entries.length;
  const statusCount = run.statuses.length;
  const sentCount = run.sent.length;

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run.tools.get("workflow_advance").execute("call", {}, controller.signal, undefined, run.ctx),
    /cancelled/,
  );

  assert.equal(run.entries.length, entryCount, "no marker appended");
  assert.equal(run.entries.at(-1).data.step, 1, "prior step stays durable");
  assert.equal(run.statuses.length, statusCount);
  assert.equal(run.sent.length, sentCount);
  assert.ok(run.activeTools.has("workflow_advance"), "run stays active");
});

test("an aborted signal rejects a workflow_start and publishes nothing", async () => {
  const root = tempRoot("workflow-cancel-start-");
  writeWorkflow(root, "cancel-start", { piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  const statusCount = run.statuses.length;

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run.tools.get(START_TOOL).execute("call", { name: "cancel-start" }, controller.signal, undefined, run.ctx),
    /cancelled/,
  );

  assert.equal(run.entries.length, 0, "no snapshot appended");
  assert.equal(run.sent.length, 0, "no follow-up published");
  assert.equal(run.statuses.length, statusCount, "no status mutation");
  assert.ok(run.activeTools.has(START_TOOL), "idle tools stay active");
  assert.ok(!run.activeTools.has("workflow_advance"), "run tools stay inactive");
});

test("an aborted signal rejects an abort and keeps the run active", async () => {
  const root = tempRoot("workflow-cancel-abort-");
  writeWorkflow(root, "cancel-abort");
  const run = harness(root);
  await startRun(run, "cancel-abort");
  const entryCount = run.entries.length;
  const sentCount = run.sent.length;

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run.tools.get("workflow_abort").execute("call", {}, controller.signal, undefined, run.ctx),
    /cancelled/,
  );

  assert.equal(run.entries.length, entryCount, "no snapshot appended");
  assert.equal(run.sent.length, sentCount, "no follow-up published");
  assert.ok(run.activeTools.has("workflow_advance"), "run stays active");
});

test("repeated session starts recapture the active tool baseline", async () => {
  const root = tempRoot("workflow-baseline-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  run.activeTools.add("custom_tool");

  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);

  assert.ok(run.activeTools.has("custom_tool"), "a fresh baseline keeps newly enabled tools");
  assert.ok(run.activeTools.has(START_TOOL));
  assert.ok(run.activeTools.has("read"));
});

// --- WI-05 (AP-06): transition messages are materialized before publication ---

test("edits made before start are preserved in the delivered message", async () => {
  const root = tempRoot("workflow-edited-step-");
  const directory = writeWorkflow(root, "auditable");
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  writeFileSync(join(directory, "steps/01-one.md"), "# EDITED STEP CONTENT\n");

  await run.commands.get("auditable").handler("", run.ctx);

  const message = run.sent.at(-1).message;
  assert.match(message, /# EDITED STEP CONTENT/, "current file content wins");
});

// --- WI-06 (AP-03): durable append is the transition commit gate ---

test("startup append failure surfaces a storage failure and publishes nothing", async () => {
  const root = tempRoot("workflow-storage-start-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  run.setAppendFailure("disk full");

  const result = await run.tools.get(START_TOOL).execute("call", { name: "auditable" }, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not committed to session storage: disk full/);
  assert.equal(result.details.status, "storage-failed");
  for (const name of RUN_TOOLS) assert.ok(!run.activeTools.has(name), name);
  assert.ok(run.activeTools.has(START_TOOL));
  assert.equal(run.notices.some((item) => /auditable started/.test(item.message)), false);
  assert.equal(run.statuses.some((item) => item.key === "pi-workflows" && item.value !== undefined), false);
  assert.equal(run.sent.length, 0);
  assert.equal(run.entries.length, 0, "no snapshot may survive a rejected commit");

  run.setAppendFailure(null);
  const fresh = harness(root, run.entries);
  await fresh.handlers.get("session_start")({ reason: "resume" }, fresh.ctx);
  for (const name of RUN_TOOLS) assert.ok(!fresh.activeTools.has(name), name);
  assert.equal(fresh.notices.some((item) => /Resumed/.test(item.message)), false);
});

test("slash-command startup append failure notifies a storage failure and publishes nothing", async () => {
  const root = tempRoot("workflow-storage-slash-");
  writeWorkflow(root, "auditable");
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  run.setAppendFailure("disk full");

  await run.commands.get("auditable").handler("", run.ctx);
  const notice = run.notices.find((item) => /not committed to session storage: disk full/.test(item.message));
  assert.ok(notice);
  assert.equal(notice.level, "error");
  for (const name of RUN_TOOLS) assert.ok(!run.activeTools.has(name), name);
  assert.equal(run.sent.length, 0);
  assert.equal(run.entries.length, 0);
});

test("advance append failure keeps the prior step active", async () => {
  const root = tempRoot("workflow-storage-advance-");
  writeWorkflow(root, "auditable", { stepFiles: ["steps/01-one.md", "steps/02-two.md"] });
  const run = harness(root);
  await startRun(run, "auditable");
  run.setAppendFailure("disk full");

  const result = await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not committed to session storage: disk full/);
  assert.equal(result.details.status, "storage-failed");
  assert.equal(result.terminate, undefined);
  for (const name of RUN_TOOLS) assert.ok(run.activeTools.has(name), name);
  assert.deepEqual(run.statuses.at(-1), { key: "pi-workflows", value: "auditable 1/2" });

  const prompt = await run.handlers.get("before_agent_start")({ systemPrompt: "base" }, run.ctx);
  assert.match(prompt.systemPrompt, /Step: 1\/2/);

  run.setAppendFailure(null);
  const retry = await run.tools.get("workflow_advance").execute("call", {}, undefined, undefined, run.ctx);
  assert.equal(retry.details.status, "active");
  assert.equal(retry.details.step, 2);
});

test("abort append failure keeps the run active", async () => {
  const root = tempRoot("workflow-storage-abort-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await startRun(run, "auditable");
  run.setAppendFailure("disk full");

  const result = await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "storage-failed");
  for (const name of RUN_TOOLS) assert.ok(run.activeTools.has(name), name);
  assert.deepEqual(run.statuses.at(-1), { key: "pi-workflows", value: "auditable 1/2" });

  run.setAppendFailure(null);
  const retry = await run.tools.get("workflow_abort").execute("call", {}, undefined, undefined, run.ctx);
  assert.equal(retry.details.status, "aborted");
  assert.ok(run.activeTools.has(START_TOOL));
  assert.ok(!run.activeTools.has("workflow_abort"));
});

test("an undelivered step cannot advance and retries after agent_settled", async () => {
  const root = tempRoot("workflow-pending-guard-");
  writeWorkflow(root, "auditable", { piVisibility: true });
  const run = harness(root);
  await run.handlers.get("session_start")({ reason: "startup" }, run.ctx);
  run.setSendFailure("queue unavailable");

  await run.tools.get(START_TOOL).execute("start", { name: "auditable" }, undefined, undefined, run.ctx);
  assert.equal(run.entries.at(-1).data.delivered, false);
  const blocked = await run.tools.get("workflow_advance").execute("advance", {}, undefined, undefined, run.ctx);
  assert.equal(blocked.isError, true);
  assert.equal(blocked.details.status, "delivery-pending");

  run.setSendFailure(null);
  await endRun(run);
  assert.match(run.sent.at(-1).message, /step 1 \(one\)/);
  assert.equal(run.entries.at(-1).data.delivered, true);
});

test("pending v2 snapshots materialize current workflow files on delivery", async () => {
  const root = tempRoot("workflow-live-files-");
  const directory = writeWorkflow(root, "auditable", { piVisibility: true });
  const entries = [{
    type: "custom",
    customType: "pi-workflows",
    data: { v: 2, status: "active", workflow: "auditable", runId: "live-run", step: 1, target: "", delivered: false },
  }];
  writeFileSync(join(directory, "steps/01-one.md"), "# Live instructions\n\nUse the current file.\n");
  const run = harness(root, entries);

  await run.handlers.get("session_start")({ reason: "resume" }, run.ctx);
  await endRun(run);
  assert.match(run.sent.at(-1).message, /Use the current file/);
  assert.equal(run.entries.at(-1).data.delivered, true);
});
