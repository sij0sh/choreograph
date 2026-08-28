import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "pwf-loop-body-"));
  roots.push(root);
  return root;
}

function harness() {
  const sent = [];
  const entries = [];
  const activeTools = new Set(["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message, deliverAs) => {
      sent.push({ message, deliverAs });
    },
  };
  const ctx = {
    ui: {
      status: undefined,
      notices: [],
      setStatus: (id, value) => {
        ctx.ui.status = value;
      },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  return { pi, ctx, sent, entries, activeTools, read };
}

function loopBodyWorkflow() {
  return workflow([
    task("gather"),
    {
      kind: "loop",
      id: "review",
      mode: "for-each",
      body: {
        kind: "sequence",
        id: "review-body",
        children: [
          task("read-one", { inputs: { item: { from: "$item" }, scope: { from: "gather", select: "/data/scope" } } }),
          task("verify"),
        ],
      },
      itemsBinding: { from: "gather", select: "/data/files" },
      maxIterations: 8,
    },
    task("deliver"),
  ], { name: "loop-body-e2e", overviewPath: join(tempDir(), "WORKFLOW.md") });
}

test("body steps receive $item and outer-scope inputs in their prompts", async () => {
  const h = harness();
  const wf = loopBodyWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read);
  runtime.handleSessionStart(h.ctx);
  const run = await runtime.startWorkflow(h.ctx, wf, "");
  assert.ok(run);
  const gather = await runtime.transition({ status: "completed", checkpoint: cp("gathered", { files: ["a", "b"], scope: "repo" }) }, undefined, h.ctx);
  assert.ok(gather, "the gather transition is accepted");
  await runtime.handleAgentSettled(h.ctx);
  const first = runtime.handleBeforeAgentStart({ systemPrompt: "" }).systemPrompt;
  assert.match(first, /loop\[1\]\/read-one/, "the prompt names the scoped body step");
  assert.match(first, /`item` from `\$item`:[\s\S]*"a"/, "the $item binding renders the first item");
  assert.match(first, /`scope` from `gather`:[\s\S]*"repo"/, "the outer-scope binding renders the gathered value");
  await runtime.transition({ status: "completed", checkpoint: cp("read a") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", checkpoint: cp("verify a") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const second = runtime.handleBeforeAgentStart({ systemPrompt: "" }).systemPrompt;
  assert.match(second, /loop\[2\]\/read-one/, "the second iteration re-enters the body");
  assert.match(second, /`item` from `\$item`:[\s\S]*"b"/, "the $item binding advances with the iteration");
  await runtime.transition({ status: "completed", checkpoint: cp("read b") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", checkpoint: cp("verify b") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  await runtime.transition({ status: "completed", checkpoint: cp("delivered") }, undefined, h.ctx);
  await runtime.handleAgentSettled(h.ctx);
  const finalEntry = h.entries.filter((entry) => entry.customType === "choreograph").at(-1);
  assert.equal(finalEntry.data.status, "completed", "the run completes through the multi-step body");
});
