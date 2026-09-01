import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { cp, task, workflow } from "../engine/helpers.mjs";

function harness() {
  const entries = [];
  const activeTools = new Set(["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.clear();
      names.forEach((name) => activeTools.add(name));
    },
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async () => {},
  };
  const ctx = {
    ui: {
      status: undefined,
      notices: [],
      widgets: {},
      setStatus: (id, value) => {
        ctx.ui.status = value;
      },
      setWidget: (id, content, options) => {
        ctx.ui.widgets[id] = content === undefined ? undefined : { content, options };
      },
      notify: (message, level) => ctx.ui.notices.push({ message, level }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const read = () => "# instructions";
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-co-widget-"));
  return { pi, ctx, entries, activeTools, read, storeRoot };
}

function simpleWorkflow() {
  return workflow([task("frame", { done: ["framed"] }), task("deliver")]);
}

function workflowWidget(ctx, width = 80) {
  const installed = ctx.ui.widgets["choreograph"];
  if (!installed) return undefined;
  const theme = { fg: (color, text) => text };
  return installed.content(undefined, theme).render(width);
}

async function startRun(ctx, runtime, wf) {
  runtime.handleSessionStart(ctx);
  await runtime.startWorkflow(ctx, wf, "");
}

test("compact mode installs the rail widget and keeps the footer clear", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [simpleWorkflow()], h.read, h.storeRoot);
  await startRun(h.ctx, runtime, simpleWorkflow());
  const installed = h.ctx.ui.widgets["choreograph"];
  assert.ok(installed, "the active run installs the widget");
  assert.deepEqual(installed.options, { placement: "aboveEditor" });
  assert.equal(typeof installed.content, "function");
  const lines = workflowWidget(h.ctx);
  assert.match(lines[0], /Demo/);
  assert.match(lines[0], /RUNNING/);
  assert.match(lines[1], /\[>\] frame/);
  assert.equal(h.ctx.ui.status, undefined, "the footer status stays cleared");
  assert.ok(lines.length <= 3, "compact stays within three lines");
});

test("detailed mode renders the same widget key with a semantic tail", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  await startRun(h.ctx, runtime, wf);
  runtime.setWorkflowUiMode("detailed", h.ctx);
  assert.equal(runtime.getWorkflowUiMode(), "detailed");
  assert.deepEqual(h.ctx.ui.widgets["choreograph"].options, { placement: "aboveEditor" });
  await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  const tail = workflowWidget(h.ctx);
  assert.ok(tail.some((line) => line.startsWith("done frame: framed")), "completed summaries render");
  assert.ok(tail.length <= 6, "detailed stays bounded");
});

test("off mode clears the widget and cycling walks every mode", async () => {
  const h = harness();
  const runtime = new RuntimeCoordinator(h.pi, [simpleWorkflow()], h.read, h.storeRoot);
  await startRun(h.ctx, runtime, simpleWorkflow());
  assert.ok(h.ctx.ui.widgets["choreograph"]);
  runtime.setWorkflowUiMode("off", h.ctx);
  assert.equal(h.ctx.ui.widgets["choreograph"], undefined);
  runtime.setWorkflowUiMode("compact", h.ctx);
  assert.ok(h.ctx.ui.widgets["choreograph"]);
  assert.equal(runtime.cycleWorkflowUiMode(h.ctx), "detailed");
  assert.equal(runtime.cycleWorkflowUiMode(h.ctx), "off");
  assert.equal(h.ctx.ui.widgets["choreograph"], undefined);
});

test("transitions and restore refresh the widget from the current snapshot", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  await startRun(h.ctx, runtime, wf);
  assert.match(workflowWidget(h.ctx)[1], /\[>\] frame/);
  await runtime.transition({ key: "root/frame", status: "needs-work", checkpoint: cp("attempt failed") }, undefined, h.ctx);
  assert.match(workflowWidget(h.ctx)[2], /attempt 2/, "the retry attempt renders");
  runtime.setWorkflowUiMode("detailed", h.ctx);
  assert.ok(workflowWidget(h.ctx).some((line) => line.includes("attempt failed")), "detailed shows the failure as attention");
  runtime.setWorkflowUiMode("compact", h.ctx);

  const fresh = harness();
  fresh.entries.push(...h.entries);
  const restored = new RuntimeCoordinator(fresh.pi, [wf], fresh.read, fresh.storeRoot);
  restored.handleSessionStart(fresh.ctx);
  assert.match(workflowWidget(fresh.ctx)[1], /\[>\] frame/, "restore re-installs the widget");
});

test("completion and abort clear the widget; no event-log entries appear", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  await startRun(h.ctx, runtime, wf);
  await runtime.abort(undefined, h.ctx);
  assert.equal(h.ctx.ui.widgets["choreograph"], undefined, "abort clears the widget");

  const completed = harness();
  const completing = new RuntimeCoordinator(completed.pi, [wf], completed.read, completed.storeRoot);
  await startRun(completed.ctx, completing, wf);
  await completing.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, completed.ctx);
  await completing.transition({ key: "root/deliver", status: "completed", checkpoint: cp("delivered") }, undefined, completed.ctx);
  assert.equal(completed.ctx.ui.widgets["choreograph"], undefined, "completion clears the widget");
  for (const session of [h, completed]) {
    assert.equal(session.entries.some((entry) => entry.customType === "choreograph-events"), false);
  }
});
