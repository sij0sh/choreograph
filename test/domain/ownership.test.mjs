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
  BLOCK_KIND_DISCRIMINATORS,
  BLOCK_KIND_KEYS,
  STEP_DISCRIMINATORS,
  instructionFileOf,
  isAgentFacingBlock,
  isBindableBlock,
  isCheckpointContractBlock,
  isGuardBearingBlock,
  isRestorableBlock,
  isToolsBearingBlock,
  scriptCwdOf,
} from "../../src/domain/workflow.ts";
import { BOUNDARY_CHECKPOINT_FIELDS, TRANSITION_SHAPE } from "../../src/domain/checkpoint.ts";
import { FRAME_KINDS, NODE_STATUSES, RUNNER_KINDS } from "../../src/persistence/snapshot.ts";
import { lifecycleRoles, RUN_LIFECYCLE_STATUSES } from "../../src/domain/run.ts";
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
    [{ kind: "task" }, true, true, true, true, true, true],
    [{ kind: "plan" }, true, true, true, true, false, false],
    [{ kind: "script" }, true, false, true, true, true, false],
    [{ kind: "loop" }, true, false, true, true, false, false],
    [{ kind: "sequence" }, false, false, false, false, false, false],
  ];
  for (const [block, guard, agent, restore, bind, contract, tools] of cases) {
    assert.equal(isGuardBearingBlock(block), guard, block.kind);
    assert.equal(isAgentFacingBlock(block), agent, block.kind);
    assert.equal(isRestorableBlock(block), restore, block.kind);
    assert.equal(isBindableBlock(block), bind, block.kind);
    assert.equal(isCheckpointContractBlock(block), contract, block.kind);
    assert.equal(isToolsBearingBlock(block), tools, block.kind);
  }
});

test("BLOCK_KIND_KEYS is the only source of authoring keys and per-kind discriminators", () => {
  const discriminators = Object.entries(BLOCK_KIND_DISCRIMINATORS);
  assert.deepEqual(discriminators.map(([, key]) => key), ["run", "plan", "script", "for_each"]);
  for (const [kind, discriminator] of discriminators) {
    assert.ok(
      Object.values(BLOCK_KIND_KEYS[kind]).includes(discriminator),
      `${discriminator} must be one of ${kind}'s own keys`,
    );
  }
  assert.equal(new Set(discriminators.map(([, key]) => key)).size, discriminators.length, "discriminators select exactly one grammar");
  assert.deepEqual([...STEP_DISCRIMINATORS], ["run", "plan", "script", "for_each"]);
});

test("instruction files, script cwds, and tool lists are answered by the owned projections", () => {
  const task = { kind: "task", id: "t", instructionPath: "steps/t.md", tools: ["read"] };
  const script = { kind: "script", id: "s", script: { argv: [], cwd: "scripts", timeoutMs: 1, acceptedExitCodes: [0], stdout: "text", stderr: "text", maxCaptureBytes: 1 } };
  const loop = { kind: "loop", id: "l" };
  assert.equal(instructionFileOf(task), "steps/t.md");
  assert.equal(instructionFileOf(script), undefined);
  assert.equal(scriptCwdOf(script), "scripts");
  assert.equal(scriptCwdOf(task), undefined);
  assert.equal(scriptCwdOf(loop), undefined);
});

test("kind-fact consumers import the owned projections, not hand-rolled checks", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = join(import.meta.dirname, "..", "..", "src");
  const mustUse = [
    ["authoring/parser.ts", "BLOCK_KIND_DISCRIMINATORS"],
    ["authoring/compile.ts", "instructionFileOf"],
    ["runtime/workflow-definition.ts", "instructionFileOf"],
    ["runtime/session.ts", "isToolsBearingBlock"],
    ["runtime/retention.ts", "scriptCwdOf"],
  ];
  for (const [file, symbol] of mustUse) {
    const text = readFileSync(join(src, file), "utf8");
    assert.ok(text.includes(symbol), `${file} must answer through ${symbol}`);
  }
});

test("every snapshot decode allowlist is exhaustiveness-linked to its domain union", () => {
  // The member sets are pinned here: a stale hand-edited list fails this test,
  // and a new union member without a list entry fails compilation (linkedMembers).
  assert.deepEqual([...NODE_STATUSES], ["running", "waiting", "succeeded", "failed", "canceled", "skipped"]);
  assert.deepEqual([...RUNNER_KINDS], ["agent", "process"]);
  assert.deepEqual([...FRAME_KINDS], ["sequence", "task", "plan", "node", "loop"]);
});

test("run lifecycle state sets and liveness roles have one owned truth table", () => {
  assert.deepEqual([...RUN_LIFECYCLE_STATUSES], ["active", "paused", "completed", "aborted"]);
  assert.deepEqual(lifecycleRoles("active"), { live: true, abortable: true });
  assert.deepEqual(lifecycleRoles("paused"), { live: false, abortable: true });
  assert.deepEqual(lifecycleRoles("completed"), { live: false, abortable: false });
  assert.deepEqual(lifecycleRoles("aborted"), { live: false, abortable: false });
});

test("session-lifecycle status literals never leak below the runtime layer", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = join(import.meta.dirname, "..", "..", "src");
  const violations = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith(".ts")) {
        const text = readFileSync(path, "utf8");
        if (/status\s*(===|!==)\s*"(paused|idle|rollover-pending)"/.test(text)) violations.push(path);
      }
    }
  };
  for (const layer of ["authoring", "planning", "engine", "pi", "domain"]) scan(join(src, layer));
  assert.deepEqual(violations, [], "only the runtime and persistence layers may branch on session lifecycle states");
});

test("runner classification, view types, and runtime routing have one owner each", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = join(import.meta.dirname, "..", "..", "src");
  const read = (file) => readFileSync(join(src, file), "utf8");
  // The engine module owns leaf-to-runner classification; no other module defines it.
  const definers = ["engine/interpreter.ts", "runtime/workflow-ui.ts"]
    .filter((file) => /function runnerOfLeaf/.test(read(file)));
  assert.deepEqual(definers, ["engine/interpreter.ts"]);
  // View types use RunnerKind, not literal runner unions.
  assert.ok(!read("runtime/workflow-ui.ts").includes('"agent" | "process"'), "the view type derives from RunnerKind");
  // Runtime-executed routing is answered by the owned predicate; processLeafAt stays in the driver's dispatch payload.
  const { readdirSync } = await import("node:fs");
  const processLeafImporters = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith(".ts") && /from "[^\"]*interpreter\.ts"/.test(readFileSync(path, "utf8")) && /processLeafAt/.test(readFileSync(path, "utf8"))) {
        processLeafImporters.push(path);
      }
    }
  };
  scan(join(src, "runtime"));
  assert.deepEqual(processLeafImporters, [join(src, "runtime", "run-driver.ts")], "only the driver dispatch consults the script-leaf payload");
});

test("the model-facing transition prompt derives its enumerations", () => {
  const wf = workflow([task("frame")]);
  const state = start(wf, { runId: "r1" }).state;
  const prompt = renderPositionEnvelope(wf, state, (path) => path.endsWith("WORKFLOW.md") ? "# Overview" : "# Frame");
  for (const status of TRANSITION_SHAPE.statuses) assert.ok(prompt.includes("`" + status + "`"));
  for (const field of BOUNDARY_CHECKPOINT_FIELDS) assert.ok(prompt.includes("`" + field + "`"));
  assert.ok(!prompt.includes("`skipped`"), "engine-owned skipped stays outside the model boundary");
});
