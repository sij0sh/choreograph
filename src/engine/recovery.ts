import type { Checkpoint } from "../domain/checkpoint.ts";
import type { Execution, Frame, PlanExecution, SequenceFrame } from "../domain/execution.ts";
import { DEFAULT_PLAN_RECOVERY, DEFAULT_TASK_RECOVERY, resolveRecovery, type RecoveryPolicy } from "../domain/policy.ts";
import type { Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { lastSegment, planKeyOf } from "../domain/keys.ts";
import { invalidateResults } from "../planning/graph.ts";
import type { Effect, EngineResult, Issue } from "./interpreter.ts";
import { advance } from "./interpreter.ts";

type Outcome = { readonly checkpoint: Checkpoint; readonly issues?: readonly Issue[] };

function deliver(state: Execution): EngineResult {
  return { ok: true, state, effect: { kind: "deliver" } as Effect };
}

function fail(error: string): EngineResult {
  return { ok: false, error };
}

function planKeyForBlock(blockId: string, state: Execution): string {
  const entry = Object.entries(state.plans).find(([, execution]) => execution.blockId === blockId);
  return entry ? entry[0] : "";
}

function attemptOf(frame: Frame): number {
  return frame.kind === "task" || frame.kind === "node" || frame.kind === "plan" ? frame.attempt : 1;
}

function withAttempt(frame: Frame, attempt: number): Frame {
  return { ...frame, attempt } as Frame;
}

function policyFor(workflow: Workflow, leaf: Frame): RecoveryPolicy | undefined {
  const block = blockOf(workflow, leaf.blockId);
  if (!block) return undefined;
  if (leaf.kind === "task" && block.kind === "task") return resolveRecovery(block.recovery, DEFAULT_TASK_RECOVERY);
  if ((leaf.kind === "node" || leaf.kind === "plan") && block.kind === "plan") return resolveRecovery(block.recovery, DEFAULT_PLAN_RECOVERY);
  return undefined;
}

function rewindToChild(workflow: Workflow, stack: readonly Frame[], blockId: string): readonly Frame[] | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame.kind !== "sequence") continue;
    const block = blockOf(workflow, frame.blockId);
    if (!block || block.kind !== "sequence") continue;
    const childIndex = block.children.findIndex((child) => child.id === blockId);
    if (childIndex < 0 || childIndex >= frame.index) continue;
    const rewound: SequenceFrame = { ...frame, index: childIndex };
    return [...stack.slice(0, i), rewound];
  }
  return undefined;
}

function resume(workflow: Workflow, state: Execution, stack: readonly Frame[]): EngineResult | undefined {
  const advanced = advance(workflow, { ...state, stack });
  if (!advanced.ok) return undefined;
  if (advanced.stack.length === 0) return fail("recovery rewound past every runnable block");
  return deliver({ ...state, stack: advanced.stack });
}

function tryInvalidate(workflow: Workflow, state: Execution, outcome: Outcome, policy: RecoveryPolicy): EngineResult | undefined {
  const targets = (outcome.issues ?? []).map((issue) => issue.target);
  if (targets.length === 0) return undefined;
  let matched: { key: string; execution: PlanExecution; removed: string[] } | undefined;
  for (const [key, execution] of Object.entries(state.plans)) {
    if (policy.scope && execution.blockId !== policy.scope) continue;
    const invalidated = invalidateResults(execution, targets);
    if (invalidated.removed.length > 0 && (!matched || invalidated.removed.length > matched.removed.length)) {
      matched = { key, execution: invalidated.execution, removed: invalidated.removed };
    }
  }
  if (matched && matched.execution.invalidations + 1 > policy.maxReplans) return undefined;
  const checkpoints = { ...state.checkpoints };
  let checkpointsRemoved = false;
  for (const key of Object.keys(checkpoints)) {
    if (targets.includes(lastSegment(key))) {
      delete checkpoints[key];
      checkpointsRemoved = true;
    }
  }
  if (matched) {
    const plans = {
      ...state.plans,
      [matched.key]: { ...matched.execution, invalidations: matched.execution.invalidations + 1 },
    };
    const rewound = rewindToChild(workflow, state.stack, matched.execution.blockId);
    if (!rewound) return undefined;
    return resume(workflow, { ...state, plans, checkpoints }, rewound);
  }
  if (checkpointsRemoved) {
    for (const target of targets) {
      const block = blockOf(workflow, target);
      if (!block) continue;
      const rewound = rewindToChild(workflow, state.stack, block.id);
      if (rewound) return resume(workflow, { ...state, checkpoints }, rewound);
    }
  }
  return undefined;
}

function tryReplan(workflow: Workflow, state: Execution, leaf: Frame, policy: RecoveryPolicy): EngineResult | undefined {
  let planKey: string | undefined;
  if (leaf.kind === "node") {
    planKey = planKeyOf(leaf.key);
  } else if (leaf.kind === "plan") {
    planKey = leaf.key;
  } else if (policy.scope) {
    planKey = planKeyForBlock(policy.scope, state) || undefined;
  }
  if (!planKey) return undefined;
  const execution = state.plans[planKey];
  if (!execution) return undefined;
  if (execution.replans + 1 > policy.maxReplans) return undefined;
  const plans = {
    ...state.plans,
    [planKey]: { ...execution, revision: execution.revision + 1, replans: execution.replans + 1, awaitingPlan: true },
  };
  const next: Execution = { ...state, plans };
  if (leaf.kind === "node" || leaf.kind === "plan") {
    let stack = [...state.stack];
    let top = stack[stack.length - 1];
    while (top.kind !== "plan") {
      stack = stack.slice(0, -1);
      top = stack[stack.length - 1];
    }
    stack[stack.length - 1] = { ...top, mode: "create", attempt: top.attempt + 1 };
    return resume(workflow, next, stack);
  }
  const rewound = rewindToChild(workflow, state.stack, execution.blockId);
  if (!rewound) return undefined;
  return resume(workflow, next, rewound);
}

export function applyNeedsWork(workflow: Workflow, state: Execution, outcome: Outcome): EngineResult {
  const stack = [...state.stack];
  const leaf = stack[stack.length - 1];
  if (!leaf) return fail("execution has no current leaf task");
  const policy = policyFor(workflow, leaf);
  if (!policy) return fail(`frame ${leaf.key} does not name a recoverable block`);
  const nextAttempt = attemptOf(leaf) + 1;
  for (const action of policy.strategy) {
    switch (action) {
      case "retry": {
        if (nextAttempt <= policy.maxAttempts) {
          stack[stack.length - 1] = withAttempt(leaf, nextAttempt);
          return deliver({ ...state, stack });
        }
        continue;
      }
      case "invalidate": {
        const applied = tryInvalidate(workflow, { ...state, stack }, outcome, policy);
        if (applied) return applied;
        continue;
      }
      case "replan": {
        const applied = tryReplan(workflow, { ...state, stack }, leaf, policy);
        if (applied && applied.ok) return applied;
        continue;
      }
      case "block":
        return stayWithCheckpoint(state, leaf.key, outcome.checkpoint);
    }
  }
  return stayWithCheckpoint(state, leaf.key, outcome.checkpoint);
}

function stayWithCheckpoint(state: Execution, key: string, checkpoint: Checkpoint): EngineResult {
  return { ok: true, state: { ...state, checkpoints: { ...state.checkpoints, [key]: checkpoint } }, effect: { kind: "stay" } as Effect };
}
