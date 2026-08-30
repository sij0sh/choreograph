import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { completed, cp, task, workflow } from "../engine/helpers.mjs";

function harness() {
  const sent = [];
  const entries = [];
  const pi = {
    getActiveTools: () => ["read", "bash"],
    getAllTools: undefined,
    setActiveTools: () => {},
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: async (message) => sent.push(message),
  };
  const ctx = {
    ui: { notices: [], setStatus() {}, notify: (message, level) => ctx.ui.notices.push({ message, level }) },
    sessionManager: { getBranch: () => entries },
  };
  const storeRoot = mkdtempSync(join(tmpdir(), "keyed-outcomes-"));
  return { pi, ctx, sent, entries, storeRoot };
}

test("a duplicated outcome for a stale position is rejected at the tool boundary (corr-c1)", async () => {
  const h = harness();
  const wf = workflow([task("frame", { done: ["framed"] }), task("deliver")]);
  const runtime = new RuntimeCoordinator(h.pi, [wf], () => "# instructions", h.storeRoot);
  runtime.handleSessionStart(h.ctx);
  await runtime.startWorkflow(h.ctx, wf, "");
  await runtime.handleAgentSettled(h.ctx);

  const first = { key: "root/frame", status: "completed", met: ["framed"], checkpoint: cp("framed") };
  const ok = await runtime.transition(first, undefined, h.ctx);
  assert.ok(!ok.isError, ok.content[0].text);

  const replay = await runtime.transition(first, undefined, h.ctx);
  assert.ok(replay.isError, "the replay is rejected");
  assert.equal(replay.details.status, "invalid-transition");
  assert.match(replay.content[0].text, /does not match position root\/deliver/);
  assert.equal(runtime.state.status, "active", "the run stays alive at its real position");
  assert.equal(runtime.state.execution.stack.at(-1).blockId, "deliver");
  await runtime.abort(undefined, h.ctx);
  rmSync(h.storeRoot, { recursive: true, force: true });
});
