import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { cp, script, task, workflow } from "../engine/helpers.mjs";
import { LIMITS } from "../../src/domain/limits.ts";

function harness(options = {}) {
  const sent = [];
  const entries = [];
  const activeTools = new Set(options.baseline ?? ["read", "bash"]);
  const pi = {
    getActiveTools: () => [...activeTools],
    getAllTools: options.allTools ? () => options.allTools.map((name) => ({ name })) : undefined,
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
  const storeRoot = mkdtempSync(join(tmpdir(), "pwf-settle-store-"));
  return { pi, ctx, sent, entries, activeTools, read, storeRoot };
}

function simpleWorkflow() {
  return workflow([task("frame", { done: ["framed"] }), task("deliver")]);
}

function stalledWorkflow() {
  return workflow([task("frame")]);
}

// One stalled agent run: the run started (agent_start) and ended without a transition.
async function stallOnce(runtime, ctx) {
  runtime.handleAgentStart();
  await runtime.handleAgentSettled(ctx);
}

function stallNotices(h) {
  return h.ctx.ui.notices.filter((notice) => notice.level === "error" && /stalled/.test(notice.message));
}

test("a reply that ends without a transition is nudged back to the tool call", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  assert.equal(h.sent.length, 1, "only the control message so far");

  await stallOnce(runtime, h.ctx);

  assert.equal(h.sent.length, 2, "the stall sends one nudge");
  assert.match(h.sent[1].message, /workflow_transition/);
  assert.match(h.sent[1].message, /root\/frame/);
  assert.equal(runtime.state.status, "active");
  assert.equal(runtime.state.execution.stack.at(-1)?.key, "root/frame", "the nudge does not move the run");
  assert.equal(runtime.state.delivered, true, "the nudge leaves the position transitionable");

  const outcome = await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!outcome.isError, "the run accepts a transition after the nudge");
});

test("a settle without an agent run never nudges", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);
  assert.equal(h.sent.length, 1, "no agent run started, so no nudge");
});

test("a run that made an accepted transition is never nudged", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  runtime.handleAgentStart();
  const outcome = await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!outcome.isError);
  await runtime.handleAgentSettled(h.ctx);
  assert.equal(h.sent.filter((entry) => /without a `workflow_transition` tool call/.test(entry.message)).length, 0, "a healthy advance sends only control messages");
});

test("nudges are bounded, then the user is told the run stalled", async () => {
  const h = harness();
  const wf = stalledWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");

  for (let index = 0; index < LIMITS.settleNudges; index += 1) {
    await stallOnce(runtime, h.ctx);
  }
  assert.equal(h.sent.length, 1 + LIMITS.settleNudges, "each stall sends exactly one nudge up to the bound");
  assert.equal(stallNotices(h).length, 0, "no stall notice while nudges remain");

  await stallOnce(runtime, h.ctx);
  await stallOnce(runtime, h.ctx);

  assert.equal(h.sent.length, 1 + LIMITS.settleNudges, "the bound stops further nudges");
  const stalls = stallNotices(h);
  assert.equal(stalls.length, 1, "the stall notice fires exactly once");
  assert.equal(runtime.state.status, "active", "the run stays active for the user to take over");
});

test("an accepted transition resets the stall episode so later stalls nudge again", async () => {
  const h = harness();
  const wf = simpleWorkflow();
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");

  await stallOnce(runtime, h.ctx);
  assert.equal(h.sent.length, 2, "first stall nudges");

  // The recovering run: agent_start, an accepted transition, then its settle.
  runtime.handleAgentStart();
  const outcome = await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!outcome.isError, "the transition succeeds after the nudge");
  await runtime.handleAgentSettled(h.ctx);

  // A later run stalls at the new position and nudges again.
  await stallOnce(runtime, h.ctx);
  const nudges = h.sent.filter((entry) => /without a `workflow_transition` tool call/.test(entry.message));
  assert.equal(nudges.length, 2, "the second episode nudges again instead of being deduped");
  assert.equal(h.sent.at(-1).message.includes("root/deliver"), true, "the new nudge names the new position");
});

test("a process leaf is never nudged", async () => {
  const h = harness();
  // The unresolvable input parks the run at the script without spawning a child,
  // so the test stays deterministic under parallel load.
  const wf = workflow([
    task("frame", { done: ["framed"] }),
    script("probe", { spec: { stdout: "json" }, inputs: { gone: { from: "frame", select: "/data/missing" } } }),
  ]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], h.read, h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");

  runtime.handleAgentStart();
  const outcome = await runtime.transition({ key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") }, undefined, h.ctx);
  assert.ok(!outcome.isError);
  assert.equal(runtime.state.execution.stack.at(-1)?.blockId, "probe", "the run stays at the script");
  await runtime.handleAgentSettled(h.ctx);

  await stallOnce(runtime, h.ctx);

  assert.equal(h.sent.length, 1, "no nudge at a process leaf");
  assert.equal(stallNotices(h).length, 0, "no stall notice");
});
