import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../../src/index.ts";

const roots = [];

function buildExtension(frontmatter, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pwf-e2e-"));
  roots.push(root);
  const dir = join(root, "demo-run");
  mkdirSync(join(dir, "steps"), { recursive: true });
  for (const file of options.files ?? ["steps/frame.md", "steps/deliver.md"]) {
    writeFileSync(join(dir, file), `# ${file}\nDo the work.`);
  }
  writeFileSync(join(dir, "WORKFLOW.md"), `---\n${frontmatter.trim()}\n---\n\n# Overview\n`);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const sent = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const notices = [];
  const ctx = () => ({
    ui: {
      setStatus: () => {},
      notify: (message, level) => notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  });
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message) => sent.push(message),
  };
  register(pi, root);
  return { pi, tools, commands, handlers, entries, sent, activeTools, notices, ctx };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const LEGACY = `
description: A legacy run.
piVisibility: true
steps:
  - steps/frame.md
  - steps/deliver.md
`;

async function settle(handlers, ctx) {
  await handlers.get("agent_settled")(undefined, ctx);
}

test("registration exposes commands and exactly four workflow tools", () => {
  const ext = buildExtension(LEGACY);
  assert.deepEqual(
    [...ext.tools.keys()].sort(),
    ["workflow_abort", "workflow_retry", "workflow_start", "workflow_transition"],
  );
  assert.ok(ext.commands.has("demo-run"));
  assert.equal(ext.tools.get("workflow_start").parameters.properties.name.enum.length, 1);
});

test("workflow_start defaults a blank target to the entire project", async () => {
  const ext = buildExtension(LEGACY);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  const started = await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "   " }, undefined, () => {}, ctx);
  assert.ok(!started.isError);
  await settle(ext.handlers, ctx);
  const prompt = ext.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /Target: the entire project/);
});

test("a full run executes through the Pi surface", async () => {
  const ext = buildExtension(LEGACY);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  const start = await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "demo target" }, undefined, () => {}, ctx);
  assert.ok(start.terminate);
  await settle(ext.handlers, ctx);
  assert.ok(ext.sent.at(-1).includes("root/frame"), "the first control message is delivered");

  const prompt1 = ext.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt1.systemPrompt, /# steps\/frame\.md/);

  const transition = ext.tools.get("workflow_transition");
  const first = await transition.execute("id", { key: "root/frame", status: "completed", checkpoint: { summary: "framed" } }, undefined, () => {}, ctx);
  assert.ok(!first.isError, first.content[0].text);
  await settle(ext.handlers, ctx);
  const prompt2 = ext.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt2.systemPrompt, /# steps\/deliver\.md/);

  const final = await transition.execute("id", { key: "root/deliver", status: "completed", checkpoint: { summary: "delivered" } }, undefined, () => {}, ctx);
  assert.ok(final.terminate);
  assert.equal(final.details.status, "completed");
  assert.equal(ext.entries.at(-1).data.status, "completed");
  assert.ok(![...ext.activeTools].includes("workflow_transition"), "idle tools return after completion");
});

test("blocked transitions keep the run resumable through the tool surface", async () => {
  const ext = buildExtension(LEGACY);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "blocked flow" }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  const transition = ext.tools.get("workflow_transition");
  const blocked = await transition.execute("id", { key: "root/frame", status: "blocked", checkpoint: { summary: "waiting" } }, undefined, () => {}, ctx);
  assert.ok(!blocked.isError);
  assert.equal(blocked.details.status, "blocked");
  const resumed = await transition.execute("id", { key: "root/frame", status: "completed", checkpoint: { summary: "unblocked" } }, undefined, () => {}, ctx);
  assert.ok(!resumed.isError);
  assert.equal(resumed.details.position, "root/deliver");
});

test("session resume restores an active run through the entry point", async () => {
  const ext = buildExtension(LEGACY);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "repo" }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  await ext.tools.get("workflow_transition").execute("id", { key: "root/frame", status: "completed", checkpoint: { summary: "framed" } }, undefined, () => {}, ctx);

  const revived = buildExtension(LEGACY);
  revived.entries.push(...ext.entries);
  const freshCtx = revived.ctx();
  revived.handlers.get("session_start")(undefined, freshCtx);
  await settle(revived.handlers, freshCtx);
  const prompt = revived.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /# steps\/deliver\.md/);
});

test("slash commands start workflows", async () => {
  const ext = buildExtension(LEGACY);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  await ext.commands.get("demo-run").handler("target-thing", ctx);
  assert.ok(ext.entries.some((entry) => entry.data.status === "active" && entry.data.execution.target === "target-thing"));
});

test("hidden workflows keep slash commands but skip the start tool and roster", () => {
  const ext = buildExtension(`
description: A hidden run.
steps:
  - steps/frame.md
`);
  assert.ok(ext.commands.has("demo-run"));
  assert.ok(!ext.tools.has("workflow_start"));
  const idle = ext.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.equal(idle, undefined);
});

test("invalid workflow metadata surfaces one session-start warning", () => {
  const root = mkdtempSync(join(tmpdir(), "pwf-e2e-"));
  roots.push(root);
  mkdirSync(join(root, "demo-run", "steps"), { recursive: true });
  writeFileSync(join(root, "demo-run", "steps", "frame.md"), "# frame");
  writeFileSync(join(root, "demo-run", "WORKFLOW.md"), "---\ndescription: ok\nsteps:\n  - steps/frame.md\n---\n");
  mkdirSync(join(root, "broken"), { recursive: true });
  writeFileSync(join(root, "broken", "WORKFLOW.md"), "---\ndescription: bad\nsteps: []\n---\n");
  const tools = new Map();
  const handlers = new Map();
  const notices = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => ["read"],
    setActiveTools: () => {},
    appendEntry: () => {},
    sendUserMessage: async () => {},
  };
  register(pi, root);
  const ctx = { ui: { setStatus: () => {}, notify: (message, level) => notices.push({ message, level }) }, sessionManager: { getBranch: () => [] } };
  handlers.get("session_start")(undefined, ctx);
  assert.ok(notices.some((notice) => /Skipped invalid workflow metadata/.test(notice.message)));
});

test("a for_each loop runs end to end and persists mid-loop", async () => {
  const ext = buildExtension(`
description: Loop run.
piVisibility: true
steps:
  - id: gather
    run: steps/frame.md
  - id: review
    for_each:
      items: { from: gather, select: /data/files }
      body: { run: steps/review-one.md }
      maxItems: 8
  - id: deliver
    run: steps/deliver.md
`, { files: ["steps/frame.md", "steps/deliver.md", "steps/review-one.md"] });
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "delivery flow" }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  const transition = ext.tools.get("workflow_transition");

  await transition.execute("id", { key: "root/gather", status: "completed", checkpoint: { summary: "listed", data: { files: ["a", "b"] } } }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  let prompt = ext.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
  assert.match(prompt, /# steps\/review-one\.md/);
  assert.match(prompt, /iteration 1 of 2/);
  assert.match(prompt, /Current item: "a"/);

  const midLoop = ext.entries.at(-1).data;
  assert.equal(midLoop.status, "active");
  assert.equal(midLoop.execution.loops["root/review"].iteration, 1);

  await transition.execute("id", { key: "root/review/loop[1]/review-one", status: "completed", checkpoint: { summary: "reviewed a" } }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  prompt = ext.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
  assert.match(prompt, /iteration 2 of 2/);
  assert.match(prompt, /Current item: "b"/);

  const final = await transition.execute("id", { key: "root/review/loop[2]/review-one", status: "completed", checkpoint: { summary: "reviewed b" } }, undefined, () => {}, ctx);
  assert.ok(!final.isError, final.content[0].text);
  await settle(ext.handlers, ctx);
  prompt = ext.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
  assert.match(prompt, /# steps\/deliver\.md/);

  const done = await transition.execute("id", { key: "root/deliver", status: "completed", checkpoint: { summary: "done" } }, undefined, () => {}, ctx);
  assert.ok(done.terminate);
  assert.equal(done.details.status, "completed");
});

const SCRIPTED = `
description: A scripted run.
piVisibility: true
steps:
  - steps/frame.md
  - id: probe
    script:
      argv: [node, -e, "process.stdout.write('computed')"]
      inheritEnv: [PATH]
  - steps/deliver.md
`;

test("a script step runs between tasks without a model turn and persists", async () => {
  const ext = buildExtension(SCRIPTED);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "script flow" }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  assert.ok(ext.sent.at(-1).includes("root/frame"), "the first control message is delivered");

  const prompt = ext.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /# steps\/frame\.md/, "the model only ever sees the task position");

  const transition = ext.tools.get("workflow_transition");
  const first = await transition.execute("id", { key: "root/frame", status: "completed", checkpoint: { summary: "framed" } }, undefined, () => {}, ctx);
  assert.ok(!first.isError, first.content[0].text);
  await settle(ext.handlers, ctx);

  const snapshots = ext.entries.filter((entry) => entry.customType === "choreograph");
  // Snapshots share the engine's live checkpoints record, so match on the
  // latest commit, whose stack describes the position at append time.
  const scriptSnapshot = snapshots.findLast((entry) => entry.data.execution?.checkpoints?.["root/probe"]);
  assert.ok(scriptSnapshot, "the script checkpoint is persisted");
  assert.equal(scriptSnapshot.data.execution.checkpoints["root/probe"].data.stdout, "computed");
  assert.equal(scriptSnapshot.data.execution.stack.at(-1).blockId, "deliver", "the run advanced past the script without a model turn");
  assert.ok(ext.sent.every((message) => !message.includes("root/probe")), "no control message names the script position");
  assert.ok(ext.sent.at(-1).includes("root/deliver"), "the post-script task is delivered");

  const prompt2 = ext.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt2.systemPrompt, /# steps\/deliver\.md/);

  const final = await transition.execute("id", { key: "root/deliver", status: "completed", checkpoint: { summary: "delivered" } }, undefined, () => {}, ctx);
  assert.ok(!final.isError, final.content[0].text);
  assert.ok(
    ext.entries.some((entry) => entry.customType === "choreograph" && entry.data.status === "completed"),
    "the run completes with a terminal snapshot",
  );
});

test("a persisted run restores through the script position", async () => {
  const ext = buildExtension(SCRIPTED);
  const ctx = ext.ctx();
  ext.handlers.get("session_start")(undefined, ctx);
  await ext.tools.get("workflow_start").execute("id", { name: "demo-run", target: "script flow" }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);
  await ext.tools.get("workflow_transition").execute("id", { key: "root/frame", status: "completed", checkpoint: { summary: "framed" } }, undefined, () => {}, ctx);
  await settle(ext.handlers, ctx);

  const revived = buildExtension(SCRIPTED);
  revived.entries.push(...ext.entries);
  const freshCtx = revived.ctx();
  revived.handlers.get("session_start")(undefined, freshCtx);
  await settle(revived.handlers, freshCtx);
  const prompt = revived.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /# steps\/deliver\.md/, "the restored run re-drives the script and continues at the next task");
});
