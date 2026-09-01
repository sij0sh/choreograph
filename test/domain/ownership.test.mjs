import test from "node:test";
import assert from "node:assert/strict";
import {
  frameAttempt,
  isAgentDispatchFrame,
  isAttemptBearingFrame,
  isLeafFrame,
  isStructuralFrame,
} from "../../src/domain/run.ts";
import {
  BLOCK_KIND_KEYS,
  isAgentFacingBlock,
  isBindableBlock,
  isCheckpointContractBlock,
  isGuardBearingBlock,
  isRestorableBlock,
} from "../../src/domain/workflow.ts";
import { BOUNDARY_CHECKPOINT_FIELDS, TRANSITION_SHAPE } from "../../src/domain/checkpoint.ts";
import { FRAME_KINDS, NODE_STATUSES, RUNNER_KINDS } from "../../src/persistence/snapshot.ts";
import { start } from "../../src/engine/interpreter.ts";
import { renderPositionEnvelope } from "../../src/runtime/prompts.ts";
import { task, workflow } from "../engine/helpers.mjs";

test("frame roles have one exhaustive truth table", () => {
  const cases = [
    [{ kind: "task", blockId: "t", key: "root/t", attempt: 2 }, true, true, false, true, 2],
    [{ kind: "node", blockId: "p", key: "root/p/n", nodeId: "n", attempt: 3 }, true, true, false, true, 3],
    [{ kind: "plan", blockId: "p", key: "root/p", mode: "create", attempt: 4 }, true, true, false, true, 4],
    [{ kind: "plan", blockId: "p", key: "root/p", mode: "execute", attempt: 5 }, false, true, true, true, 5],
    [{ kind: "sequence", blockId: "root", key: "root", index: 1 }, false, false, true, false, 1],
    [{ kind: "loop", blockId: "each", key: "root/each" }, false, false, true, false, 1],
  ];
  for (const [frame, leaf, attemptBearing, structural, agentDispatch, attempt] of cases) {
    assert.equal(isLeafFrame(frame), leaf, frame.kind);
    assert.equal(isAttemptBearingFrame(frame), attemptBearing, frame.kind);
    assert.equal(isStructuralFrame(frame), structural, frame.kind);
    assert.equal(isAgentDispatchFrame(frame), agentDispatch, frame.kind);
    assert.equal(frameAttempt(frame), attempt, frame.kind);
  }
});

test("block keys and roles are owned beside the Block union", () => {
  assert.deepEqual(Object.keys(BLOCK_KIND_KEYS), ["task", "plan", "script", "loop"]);
  const cases = [
    [{ kind: "task" }, true, true, true, true, true],
    [{ kind: "plan" }, true, true, true, true, false],
    [{ kind: "script" }, true, false, true, true, true],
    [{ kind: "loop" }, true, false, true, true, false],
    [{ kind: "sequence" }, false, false, false, false, false],
  ];
  for (const [block, guard, agent, restore, bind, contract] of cases) {
    assert.equal(isGuardBearingBlock(block), guard, block.kind);
    assert.equal(isAgentFacingBlock(block), agent, block.kind);
    assert.equal(isRestorableBlock(block), restore, block.kind);
    assert.equal(isBindableBlock(block), bind, block.kind);
    assert.equal(isCheckpointContractBlock(block), contract, block.kind);
  }
});

test("every snapshot decode allowlist is exhaustiveness-linked to its domain union", () => {
  // The member sets are pinned here: a stale hand-edited list fails this test,
  // and a new union member without a list entry fails compilation (linkedMembers).
  assert.deepEqual([...NODE_STATUSES], ["running", "waiting", "succeeded", "failed", "canceled", "skipped"]);
  assert.deepEqual([...RUNNER_KINDS], ["agent", "process"]);
  assert.deepEqual([...FRAME_KINDS], ["sequence", "task", "plan", "node", "loop"]);
});

test("the model-facing transition prompt derives its enumerations", () => {
  const wf = workflow([task("frame")]);
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPositionEnvelope(wf, state, (path) => path.endsWith("WORKFLOW.md") ? "# Overview" : "# Frame");
  for (const status of TRANSITION_SHAPE.statuses) assert.ok(prompt.includes("`" + status + "`"));
  for (const field of BOUNDARY_CHECKPOINT_FIELDS) assert.ok(prompt.includes("`" + field + "`"));
  assert.ok(!prompt.includes("`skipped`"), "engine-owned skipped stays outside the model boundary");
});
