import type { Checkpoint } from "../domain/checkpoint.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import type { Execution, Frame, PlanExecution, SequenceFrame } from "../domain/execution.ts";
import { DEFAULT_PLAN_RECOVERY, DEFAULT_TASK_RECOVERY, resolveRecovery, type RecoveryPolicy } from "../domain/policy.ts";
import type { Workflow } from "../domain/workflow.ts";
import { bindingConsumers, blockOf, workflowBlocks } from "../domain/workflow.ts";
import { lastSegment, planKeyOf } from "../domain/keys.ts";
import { invalidateResults } from "../planning/graph.ts";
import type { Effect, EngineResult, Issue } from "./interpreter.ts";
import { advance, enterInvocation } from "./interpreter.ts";


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
  if (leaf.kind === "task" && block.kind === "script") return resolveRecovery(block.recovery, DEFAULT_TASK_RECOVERY);
  if ((leaf.kind === "node" || leaf.kind === "plan") && block.kind === "plan") return resolveRecovery(block.recovery, DEFAULT_PLAN_RECOVERY);
  return undefined;
}

function checkpointContractError(workflow: Workflow, state: Execution, leaf: Frame, checkpoint: Checkpoint): string | undefined {
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    return block?.kind === "task" ? contractErrorFor(workflow, block.output, checkpoint.data, `checkpoint ${leaf.key}`) : undefined;
  }
  if (leaf.kind !== "node") return undefined;
  const execution = state.plans[planKeyOf(leaf.key)];
  const node = execution?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  return node ? contractErrorFor(workflow, workflow.operators.get(node.operator)?.output, checkpoint.data, `checkpoint ${leaf.key}`) : undefined;
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

function loopOwningBody(workflow: Workflow, blockId: string): string | undefined {
  for (const block of workflowBlocks(workflow)) {
    if (block.kind === "loop" && block.body.children.some((child) => child.id === blockId)) return block.id;
  }
  return undefined;
}

function pruneLoops(workflow: Workflow, state: Execution, stack: readonly Frame[]): Execution {
  const active = new Set(stack.filter((frame) => frame.kind === "loop").map((frame) => (frame as { key: string }).key));
  const loops = { ...state.loops };
  const checkpoints = { ...state.checkpoints };
  let changed = false;
  for (const key of Object.keys(state.loops)) {
    if (active.has(key)) continue;
    delete loops[key];
    changed = true;
    for (const cpKey of Object.keys(checkpoints)) {
      if (cpKey === key || cpKey.startsWith(`${key}/`)) delete checkpoints[cpKey];
    }
  }
  if (!changed) return state;
  const checkpointOrder = state.checkpointOrder.filter((key) => checkpoints[key] !== undefined);
  return { ...state, loops, checkpoints, checkpointOrder };
}

function resume(workflow: Workflow, state: Execution, stack: readonly Frame[]): EngineResult | undefined {
  const pruned = pruneLoops(workflow, state, stack);
  const advanced = advance(workflow, { ...pruned, stack });
  if (!advanced.ok) return undefined;
  if (advanced.state.stack.length === 0) return fail("recovery rewound past every runnable block");
  const leaf = advanced.state.stack[advanced.state.stack.length - 1];
  if (leaf && (leaf.kind === "task" || leaf.kind === "plan" || leaf.kind === "node")) {
    return deliver(enterInvocation(workflow, advanced.state, leaf));
  }
  return deliver(advanced.state);
}

function blockOrder(workflow: Workflow): ReadonlyMap<string, number> {
  return new Map(workflowBlocks(workflow).map((block, index) => [block.id, index]));
}

function rewindToEarliest(workflow: Workflow, stack: readonly Frame[], candidates: ReadonlySet<string>): readonly Frame[] | undefined {
  const order = blockOrder(workflow);
  const targets = new Set<string>();
  for (const candidate of candidates) {
    targets.add(loopOwningBody(workflow, candidate) ?? candidate);
  }
  const ordered = [...targets].sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
  for (const blockId of ordered) {
    const rewound = rewindToChild(workflow, stack, blockId);
    if (rewound) return rewound;
  }
  return undefined;
}

function resetConsumerPlans(workflow: Workflow, state: Execution, planIds: ReadonlySet<string>): Execution | undefined {
  const plans = { ...state.plans };
  for (const [key, execution] of Object.entries(state.plans)) {
    if (!planIds.has(execution.blockId)) continue;
    const block = blockOf(workflow, execution.blockId);
    if (!block || block.kind !== "plan") continue;
    const recovery = resolveRecovery(block.recovery, DEFAULT_PLAN_RECOVERY);
    if (execution.invalidations + 1 > recovery.maxReplans) return undefined;
    plans[key] = {
      ...execution,
      revision: execution.revision + 1,
      invalidations: execution.invalidations + 1,
      awaitingPlan: true,
      results: {},
      resultOperators: {},
    };
  }
  return { ...state, plans };
}

function removeConsumerCheckpoints(state: Execution, consumers: ReadonlySet<string>): Execution {
  if (consumers.size === 0) return state;
  const checkpoints = { ...state.checkpoints };
  for (const key of Object.keys(checkpoints)) {
    if (consumers.has(lastSegment(key))) delete checkpoints[key];
  }
  const checkpointOrder = state.checkpointOrder.filter((key) => checkpoints[key] !== undefined);
  return { ...state, checkpoints, checkpointOrder };
}

function tryInvalidate(workflow: Workflow, state: Execution, outcome: Outcome, policy: RecoveryPolicy): EngineResult | undefined {
  const targets = (outcome.issues ?? []).map((issue) => issue.target);
  if (targets.length === 0) return undefined;
  const leaf = state.stack[state.stack.length - 1];
  const currentPlanKey = leaf?.kind === "node" ? planKeyOf(leaf.key) : leaf?.kind === "plan" ? leaf.key : undefined;
  let matched: { key: string; execution: PlanExecution; removed: string[] } | undefined;
  const currentPlan = currentPlanKey ? state.plans[currentPlanKey] : undefined;
  const nodeIdsFor = (key: string, execution: PlanExecution): string[] => {
    const ids = new Set([...execution.plan.nodes.map((node) => node.id), ...Object.keys(execution.results)]);
    return [...ids].filter((id) => targets.some((target) => target === `${key}/${id}` || (target === id && !blockOf(workflow, target))));
  };
  const currentNodeIds = currentPlanKey && currentPlan ? nodeIdsFor(currentPlanKey, currentPlan) : [];
  if (currentPlan && currentNodeIds.length > 0) {
    const invalidated = invalidateResults(currentPlan, currentNodeIds);
    if (invalidated.removed.length > 0) matched = { key: currentPlanKey!, execution: invalidated.execution, removed: invalidated.removed };
  } else {
    const dynamicMatches = new Map<string, Set<string>>();
    for (const [key, execution] of Object.entries(state.plans)) {
      if (policy.scope && execution.blockId !== policy.scope) continue;
      const nodeIds = nodeIdsFor(key, execution);
      if (nodeIds.length > 0) dynamicMatches.set(key, new Set(nodeIds));
    }
    if (dynamicMatches.size > 1) return undefined;
    const dynamicEntries = [...dynamicMatches.entries()];
    if (dynamicEntries.length === 1) {
      const [key, nodeIds] = dynamicEntries[0];
      const execution = state.plans[key];
      const invalidated = invalidateResults(execution, [...nodeIds]);
      if (invalidated.removed.length > 0) matched = { key, execution: invalidated.execution, removed: invalidated.removed };
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
  const checkpointOrder = state.checkpointOrder.filter((key) => checkpoints[key] !== undefined);
  const withoutInvalid: Execution = { ...state, checkpoints, checkpointOrder };
  const producers = new Set<string>();
  for (const target of targets) {
    const block = blockOf(workflow, target);
    if (block?.kind === "task" || block?.kind === "plan") producers.add(block.id);
  }
  if (matched) producers.add(matched.execution.blockId);

  const consumers = bindingConsumers(workflow, producers);
  const planConsumers = new Set<string>(consumers);
  if (!matched) {
    for (const producer of producers) {
      if (blockOf(workflow, producer)?.kind === "plan") planConsumers.add(producer);
    }
  }
  const reset = resetConsumerPlans(workflow, withoutInvalid, planConsumers);
  if (!reset) return undefined;
  const invalidatedState = removeConsumerCheckpoints(reset, consumers);
  const candidates = new Set<string>([...producers, ...consumers]);
  if (matched) {
    const plans = {
      ...invalidatedState.plans,
      [matched.key]: { ...matched.execution, invalidations: matched.execution.invalidations + 1 },
    };
    candidates.add(matched.execution.blockId);
    const rewound = rewindToEarliest(workflow, state.stack, candidates);
    if (!rewound) return undefined;
    return resume(workflow, { ...invalidatedState, plans }, rewound);
  }
  if (checkpointsRemoved || consumers.size > 0) {
    const rewound = rewindToEarliest(workflow, state.stack, candidates);
    if (rewound) return resume(workflow, invalidatedState, rewound);
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
  const checkpointError = checkpointContractError(workflow, state, leaf, outcome.checkpoint);
  if (checkpointError) return fail(checkpointError);
  const nextAttempt = attemptOf(leaf) + 1;
  for (const action of policy.strategy) {
    switch (action) {
      case "retry": {
        if (nextAttempt <= policy.maxAttempts) {
          stack[stack.length - 1] = withAttempt(leaf, nextAttempt);
          return deliver(enterInvocation(workflow, { ...state, stack }, leaf, "running", nextAttempt));
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
        return stayWithCheckpoint(workflow, state, leaf, outcome.checkpoint);
    }
  }
  return stayWithCheckpoint(workflow, state, leaf, outcome.checkpoint);
}

function stayWithCheckpoint(workflow: Workflow, state: Execution, leaf: Frame, checkpoint: Checkpoint): EngineResult {
  const waiting = enterInvocation(workflow, state, leaf, "waiting");
  const checkpoints = { ...waiting.checkpoints, [leaf.key]: checkpoint };
  const checkpointOrder = waiting.checkpointOrder.includes(leaf.key) ? waiting.checkpointOrder : [...waiting.checkpointOrder, leaf.key];
  return { ok: true, state: { ...waiting, checkpoints, checkpointOrder }, effect: { kind: "stay" } as Effect };
}
