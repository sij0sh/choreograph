import type { Checkpoint } from "../domain/checkpoint.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import type { Execution, Frame } from "../domain/execution.ts";
import { DEFAULT_RECOVERY, type RecoveryPolicy } from "../domain/policy.ts";
import { blockOf, type Workflow } from "../domain/workflow.ts";
import { planKeyOf } from "../domain/keys.ts";
import type { Effect, EngineResult, Issue } from "./interpreter.ts";
import { enterInvocation } from "./interpreter.ts";

type Outcome = { readonly checkpoint: Checkpoint; readonly issues?: readonly Issue[] };

function deliver(state: Execution): EngineResult {
  return { ok: true, state, effect: { kind: "deliver" } as Effect };
}

function fail(error: string): EngineResult {
  return { ok: false, error };
}

function attemptOf(frame: Frame): number {
  return frame.kind === "task" || frame.kind === "node" || frame.kind === "plan" ? frame.attempt : 1;
}

function withAttempt(frame: Frame, attempt: number): Frame {
  return { ...frame, attempt } as Frame;
}

function policyFor(workflow: Workflow, leaf: Frame): RecoveryPolicy {
  const block = blockOf(workflow, leaf.blockId);
  const maxAttempts = block && "recovery" in block ? block.recovery?.maxAttempts : undefined;
  return { maxAttempts: maxAttempts ?? DEFAULT_RECOVERY.maxAttempts };
}

function checkpointContractError(workflow: Workflow, state: Execution, leaf: Frame, checkpoint: Checkpoint): string | undefined {
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    return block?.kind === "task" ? contractErrorFor(workflow, block.output, checkpoint.data, `checkpoint ${leaf.key}`) : undefined;
  }
  if (leaf.kind !== "node") return undefined;
  const execution = state.plans[planKeyOf(leaf.key)];
  const node = execution?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  if (!node) return undefined;
  const operator = workflow.operators.get(node.operator);
  if (!operator || operator.script) return undefined; // a process node's failure checkpoint carries no agent-authored data
  return contractErrorFor(workflow, operator.output, checkpoint.data, `checkpoint ${leaf.key}`);
}

function recordCheckpoint(state: Execution, key: string, checkpoint: Checkpoint): Execution {
  const checkpoints = { ...state.checkpoints, [key]: checkpoint };
  const checkpointOrder = state.checkpointOrder.includes(key) ? state.checkpointOrder : [...state.checkpointOrder, key];
  return { ...state, checkpoints, checkpointOrder };
}

export function applyNeedsWork(workflow: Workflow, state: Execution, outcome: Outcome): EngineResult {
  const stack = [...state.stack];
  const leaf = stack[stack.length - 1];
  if (!leaf) return fail("execution has no current leaf task");
  if (!blockOf(workflow, leaf.blockId)) return fail(`frame ${leaf.key} does not name a recoverable block`);
  const checkpointError = checkpointContractError(workflow, state, leaf, outcome.checkpoint);
  if (checkpointError) return fail(checkpointError);
  const nextAttempt = attemptOf(leaf) + 1;
  if (nextAttempt <= policyFor(workflow, leaf).maxAttempts) {
    stack[stack.length - 1] = withAttempt(leaf, nextAttempt);
    const recorded = recordCheckpoint({ ...state, stack }, leaf.key, outcome.checkpoint);
    return deliver(enterInvocation(workflow, recorded, leaf, "running", nextAttempt));
  }
  return stayWithCheckpoint(workflow, state, leaf, outcome.checkpoint);
}

function stayWithCheckpoint(workflow: Workflow, state: Execution, leaf: Frame, checkpoint: Checkpoint): EngineResult {
  const waiting = enterInvocation(workflow, state, leaf, "waiting");
  const recorded = recordCheckpoint(waiting, leaf.key, checkpoint);
  return { ok: true, state: recorded, effect: { kind: "stay" } as Effect };
}
