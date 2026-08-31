import type { Checkpoint, TransitionStatus } from "../domain/checkpoint.ts";
import { checkpointErrors, validateCheckpoint } from "../domain/checkpoint.ts";
import {
  frameAttempt,
  isAttemptBearingFrame,
  isLeafFrame,
  upsertInvocation,
  type Execution,
  type Frame,
  type LoopFrame,
  type LoopState,
  type NodeFrame,
  type PlanExecution,
  type SequenceFrame,
  type TaskFrame,
} from "../domain/execution.ts";
import { applyNeedsWork } from "./recovery.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import { lastSegment, planKeyOf, scopeKey } from "../domain/keys.ts";
import { noteCheckpointCommitted, noteCheckpointRemoved, notePlanKeyCreated, notePlanKeyRemoved } from "../domain/checkpoint-index.ts";
import { evaluateGuard, skipReason, type GuardClause } from "../domain/guard.ts";
import type { LoopBlock, OperatorDescriptor, PlanBlock, ScriptBlock, ScriptSpec, SequenceBlock, TaskBlock, Workflow } from "../domain/workflow.ts";
import { blockOf, isGuardBearingBlock } from "../domain/workflow.ts";
import { type NodeInvocation, type NodeStatus, type RunnerKind } from "../domain/node.ts";
import { isArtifactRef, resolveBinding, type ArtifactSinkProvider } from "../domain/artifacts.ts";
import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { firstIncompleteNode } from "../planning/graph.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";
import { processOutput, utf8Preview, type ProcessExitEvent } from "./script-output.ts";

export type Issue = {
  readonly target: string;
  readonly reason: string;
};

type OutcomePayloads = {
  completed: { readonly met?: readonly string[] };
  "needs-work": { readonly issues?: readonly Issue[] };
  blocked: {};
};

type AssertNever<T extends never> = T;
type MissingOutcomeStatus = AssertNever<Exclude<TransitionStatus, keyof OutcomePayloads>>;
type UnexpectedOutcomeStatus = AssertNever<Exclude<keyof OutcomePayloads, TransitionStatus>>;

export type TaskOutcome = {
  [Status in keyof OutcomePayloads]: { readonly status: Status; readonly key: string; readonly checkpoint: Checkpoint } & OutcomePayloads[Status];
}[keyof OutcomePayloads];

type WorkflowEvent =
  | { readonly type: "outcome"; readonly outcome: TaskOutcome }
  | ProcessExitEvent;

export type Effect =
  | { readonly kind: "deliver" }
  | { readonly kind: "stay" }
  | { readonly kind: "complete" }
  | { readonly kind: "run-process"; readonly key: string };

export type EngineResult =
  | { readonly ok: true; readonly state: Execution; readonly effect: Effect }
  | { readonly ok: false; readonly error: string };

interface StartInput {
  readonly runId: string;
  readonly target?: string;
}

function fail(error: string): EngineResult {
  return { ok: false, error };
}


interface ProcessLeaf {
  readonly key: string;
  readonly blockId: string;
  readonly script: ScriptSpec;
  readonly inputs?: ScriptBlock["inputs"];
}

function scriptLeafAt(workflow: Workflow, state: Execution): { key: string; block: ScriptBlock } | undefined {
  if (state.status !== "active") return undefined;
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || leaf.kind !== "task") return undefined;
  const block = blockOf(workflow, leaf.blockId);
  return block?.kind === "script" ? { key: leaf.key, block } : undefined;
}

function sequenceAt(workflow: Workflow, frame: SequenceFrame): SequenceBlock | undefined {
  const block = blockOf(workflow, frame.blockId);
  return block?.kind === "sequence" ? block : undefined;
}

function loopAt(workflow: Workflow, blockId: string): LoopBlock | undefined {
  const block = blockOf(workflow, blockId);
  return block?.kind === "loop" ? block : undefined;
}

function childKey(parentKey: string, childId: string): string {
  return `${parentKey}/${childId}`;
}

type PushResult = { leaf: boolean; loops?: Record<string, LoopState> } | { error: string };

function pushBlock(workflow: Workflow, state: Execution, stack: Frame[], parentKey: string, childId: string): PushResult {
  const child = blockOf(workflow, childId);
  if (!child) return { error: `unknown block id: ${childId}` };
  const key = childKey(parentKey, child.id);
  const view: Execution = { ...state, stack };
  switch (child.kind) {
    case "task":
      stack.push({ kind: "task", blockId: child.id, key, attempt: 1 });
      return { leaf: true };
    case "script":
      stack.push({ kind: "task", blockId: child.id, key, attempt: 1 });
      return { leaf: true };
    case "sequence":
      stack.push({ kind: "sequence", blockId: child.id, key, index: 0 });
      return { leaf: false };
    case "loop": {
      const existing = state.loops[key];
      if (existing) {
        stack.push({ kind: "loop", blockId: child.id, key });
        return { leaf: false };
      }
      const resolved = resolveBinding(workflow, view, child.itemsBinding);
      if (!resolved.ok) return { error: `loop ${child.id} could not resolve items: ${resolved.error}` };
      if (!Array.isArray(resolved.value)) return { error: `loop ${child.id} items must resolve to a list` };
      if (resolved.value.length > child.maxIterations) {
        return { error: `loop ${child.id} has ${resolved.value.length} items, above its cap of ${child.maxIterations}` };
      }
      stack.push({ kind: "loop", blockId: child.id, key });
      return {
        leaf: false,
        loops: { ...state.loops, [key]: { iteration: 1, items: resolved.value as readonly JsonValue[] } },
      };
    }
    case "plan": {
      const existing = state.plans[key];
      if (existing && firstIncompleteNode(existing)) {
        stack.push({ kind: "plan", blockId: child.id, key, mode: "execute", attempt: 1 });
        return { leaf: false };
      }
      if (existing) return { leaf: false };
      stack.push({ kind: "plan", blockId: child.id, key, mode: "create", attempt: 1 });
      return { leaf: true };
    }
    default:
      return { error: `block kind "${(child as { kind: string }).kind}" is not supported yet` };
  }
}

type AdvanceResult = { ok: true; state: Execution } | { ok: false; error: string };

function clipSummary(value: string): string {
  return utf8Preview(value, LIMITS.checkpointSummaryBytes - 64);
}

function skipBlock(state: Execution, parentKey: string, guard: GuardClause, blockId: string, isPlan: boolean): Execution {
  const key = childKey(parentKey, blockId);
  const withCp = withCheckpoint(state, key, { summary: clipSummary(skipReason(guard)), skipped: true });
  if (!isPlan) return withCp;
  const plans = { ...withCp.plans };
  for (const [planKey, execution] of Object.entries(plans)) {
    if (execution.blockId === blockId) {
      delete plans[planKey];
      notePlanKeyRemoved(withCp, blockId, planKey);
    }
  }
  return { ...withCp, plans };
}

/**
 * The loop aggregate has one fixed shape: mode, iteration count, and per-iteration records
 * whose outputs are artifact references into the run's store. The schema never varies with
 * output size, so downstream consumers always know what a binding resolves to.
 */
function finishLoop(state: Execution, loopKey: string, block: LoopBlock, store: ArtifactSinkProvider): { state: Execution } | { error: string } {
  const loopState = state.loops[loopKey];
  if (!loopState) return { error: `loop frame ${loopKey} has no loop state` };
  const items = loopState.items ?? [];
  const iterations = items.length;
  const sink = store.sinkFor(loopKey);
  const results: JsonValue[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const record: Record<string, JsonValue> = { iteration, item: items[iteration - 1] };
    const outputs: Record<string, JsonValue> = {};
    const scoped = `${scopeKey(loopKey, iteration)}/`;
    for (const key of state.checkpointOrder) {
      if (!key.startsWith(scoped)) continue;
      const data = state.checkpoints[key]?.data;
      if (data === undefined) continue;
      const stepId = lastSegment(key);
      if (isArtifactRef(data)) {
        outputs[stepId] = data as unknown as JsonValue;
        continue;
      }
      try {
        outputs[stepId] = sink.publishJson(`${iteration}/${stepId}`, data) as unknown as JsonValue;
      } catch (error) {
        return { error: `loop ${block.id} could not store the iteration ${iteration} output of ${stepId}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    record.outputs = outputs;
    results.push(record as JsonValue);
  }
  const data: Record<string, JsonValue> = { mode: "for-each", iterations, results: results as JsonValue };
  const summaryText = `Loop ${block.id} completed ${iterations} iteration${iterations === 1 ? "" : "s"}.`;
  const checkpoint: Checkpoint = { summary: clipSummary(summaryText), data: data as JsonValue };
  const errors = checkpointErrors(checkpoint, `loop ${loopKey}`);
  if (errors.length > 0) return { error: joined(errors) ?? `loop ${loopKey} aggregate exceeded its checkpoint budget` };
  const loops = { ...state.loops };
  delete loops[loopKey];
  return { state: withCheckpoint({ ...state, loops }, loopKey, checkpoint) };
}

export function advance(workflow: Workflow, state: Execution, store?: ArtifactSinkProvider): AdvanceResult {
  const stack = [...state.stack];
  let working: Execution = state;
  let steps = 0;
  while (stack.length > 0) {
    if (++steps > LIMITS.advanceSteps) return { ok: false, error: "execution advance exceeded its step bound" };
    const topIndex = stack.length - 1;
    const top = stack[topIndex];
    switch (top.kind) {
      case "sequence": {
        const block = sequenceAt(workflow, top);
        if (!block) return { ok: false, error: `frame ${top.key} does not name a sequence` };
        const child = block.children[top.index];
        if (!child) {
          stack.pop();
          continue;
        }
        const advanced: SequenceFrame = { ...top, index: top.index + 1 };
        stack[topIndex] = advanced;
        if (isGuardBearingBlock(child) && child.guard) {
          const view: Execution = { ...working, stack };
          const guard = evaluateGuard(workflow, view, child.guard);
          if (!guard.ok) return { ok: false, error: `guard for ${child.id} could not resolve: ${guard.error}` };
          if (!guard.holds) {
            working = skipBlock(working, advanced.key, child.guard, child.id, child.kind === "plan");
            continue;
          }
        }
        const pushed = pushBlock(workflow, { ...working, stack }, stack, advanced.key, child.id);
        if ("error" in pushed) return { ok: false, error: pushed.error };
        if (pushed.loops) working = { ...working, loops: pushed.loops };
        if (pushed.leaf) return { ok: true, state: { ...working, stack } };
        continue;
      }
      case "loop": {
        const block = loopAt(workflow, top.blockId);
        if (!block) return { ok: false, error: `frame ${top.key} does not name a loop` };
        const loopState = working.loops[top.key];
        if (!loopState) return { ok: false, error: `loop frame ${top.key} has no loop state` };
        if (loopState.iteration > (loopState.items?.length ?? 0)) {
          if (!store) return { ok: false, error: `loop ${block.id} cannot record its aggregate: the run has no artifact store` };
          const finished = finishLoop(working, top.key, block, store);
          if ("error" in finished) return { ok: false, error: finished.error };
          stack.pop();
          working = finished.state;
          continue;
        }
        const scoped = scopeKey(top.key, loopState.iteration);
        if (working.checkpoints[`${scoped}/${block.body.id}`] !== undefined) {
          working = { ...working, loops: { ...working.loops, [top.key]: { ...loopState, iteration: loopState.iteration + 1 } } };
          continue;
        }
        if (loopState.iteration > block.maxIterations) {
          return { ok: false, error: `loop ${block.id} exceeded its iteration cap of ${block.maxIterations}` };
        }
        stack.push({ kind: "task", blockId: block.body.id, key: `${scoped}/${block.body.id}`, attempt: 1 });
        continue;
      }
      case "plan": {
        if (top.mode === "create") return { ok: true, state: { ...working, stack } };
        const execution = state.plans[top.key];
        if (!execution || execution.blockId !== top.blockId) return { ok: false, error: `plan frame ${top.key} has no execution` };
        const node = firstIncompleteNode(execution);
        if (!node) {
          stack.pop();
          continue;
        }
        stack.push({ kind: "node", blockId: top.blockId, key: `${top.key}/${node.id}`, nodeId: node.id, attempt: 1 });
        return { ok: true, state: { ...working, stack } };
      }
      case "task":
      case "node":
        return { ok: true, state: { ...working, stack } };
      default:
        return { ok: false, error: `frame kind "${(top as Frame).kind}" is not supported yet` };
    }
  }
  return { ok: true, state: { ...working, stack } };
}

function checkCriteria(criteria: readonly string[], met: readonly string[]): string | undefined {
  const known = new Set(criteria);
  const unknownIds = met.filter((id) => !known.has(id));
  const metSet = new Set(met);
  const missingIds = criteria.filter((id) => !metSet.has(id));
  if (metSet.size !== met.length) return "met must not contain duplicates";
  if (unknownIds.length === 0 && missingIds.length === 0) return undefined;
  const parts: string[] = [];
  if (unknownIds.length > 0) parts.push(`unknown criterion id: ${unknownIds.join(", ")}`);
  if (missingIds.length > 0) parts.push(`completion must list every required criterion; missing: ${missingIds.join(", ")}`);
  if (criteria.length > 0) parts.push(`required ids for this position: ${criteria.map((id) => `\`${id}\``).join(", ")}`);
  return parts.join("; ");
}

function joined(errors: readonly string[]): string | undefined {
  const unique = [...new Set(errors.filter((error) => error.trim().length > 0))];
  return unique.length > 0 ? unique.join("; ") : undefined;
}

function outcomeShapeErrors(outcome: TaskOutcome): string[] {
  const errors: string[] = [];
  const raw = outcome as { met?: unknown; issues?: unknown };
  if (outcome.status !== "completed" && raw.met !== undefined) errors.push("met is only valid with status \"completed\"");
  if (outcome.status !== "needs-work" && raw.issues !== undefined) errors.push("issues is only valid with status \"needs-work\"");
  if (raw.met !== undefined) {
    if (!Array.isArray(raw.met)) {
      errors.push("met must be a list of criterion ids");
    } else {
      const offending = [...new Set(raw.met.filter((id) => typeof id !== "string" || !ID_PATTERN.test(id)))];
      if (offending.length > 0) errors.push(`met entries must match ${ID_PATTERN} (offending: ${offending.map((id) => JSON.stringify(id)).join(", ")}); use the required ids below verbatim`);
    }
  }
  if (raw.issues !== undefined) {
    if (!Array.isArray(raw.issues)) {
      errors.push("issues must be a list");
    } else {
      raw.issues.forEach((issue, index) => {
        if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
          errors.push(`issues[${index}] must be an object`);
          return;
        }
        const entry = issue as { target?: unknown; reason?: unknown };
        if (typeof entry.target !== "string" || !entry.target.trim()) errors.push(`issues[${index}].target must be a non-empty string`);
        if (typeof entry.reason !== "string" || !entry.reason.trim()) errors.push(`issues[${index}].reason must be a non-empty string`);
      });
    }
  }
  return errors;
}

function completedProblems(workflow: Workflow, state: Execution, leaf: Frame, outcome: Extract<TaskOutcome, { status: "completed" }>, planExempt: boolean): string[] {
  const errors = [...outcomeShapeErrors(outcome), ...checkpointErrors(outcome.checkpoint, "checkpoint", planExempt)];
  const met = outcome.met ?? [];
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    if (!block || block.kind !== "task") {
      errors.push(`frame ${leaf.key} does not name a task`);
      return errors;
    }
    const criteria = checkCriteria(block.done ?? [], met);
    if (criteria) errors.push(criteria);
    const contract = contractErrorFor(workflow, block.output, outcome.checkpoint.data, `task ${leaf.key} output`);
    if (contract) errors.push(contract);
    return errors;
  }
  if (leaf.kind === "plan") {
    const block = blockOf(workflow, leaf.blockId);
    if (!block || block.kind !== "plan") {
      errors.push(`frame ${leaf.key} does not name a plan block`);
      return errors;
    }
    const planValue = (outcome.checkpoint.data as { plan?: unknown } | undefined)?.plan;
    if (planValue === undefined) {
      errors.push("plan creation completion must carry checkpoint.data.plan");
      return errors;
    }
    const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators));
    if ("errors" in validation) errors.push(`invalid plan: ${validation.errors.join("; ")}`);
    return errors;
  }
  if (leaf.kind === "node") {
    const planKey = planKeyOfNode(leaf);
    const execution = state.plans[planKey];
    if (!execution || execution.blockId !== leaf.blockId) {
      errors.push(`node frame ${leaf.key} has no plan execution`);
      return errors;
    }
    const node = execution.plan.nodes.find((entry) => entry.id === leaf.nodeId);
    if (!node) {
      errors.push(`node ${leaf.nodeId} is not in the active plan`);
      return errors;
    }
    const criteria = checkCriteria(node.done, met);
    if (criteria) errors.push(criteria);
    const operator = workflow.operators.get(node.operator);
    const contract = contractErrorFor(workflow, operator?.output, outcome.checkpoint.data, `node result ${node.id}`);
    if (contract) errors.push(contract);
    try {
      const result = validateCheckpoint(outcome.checkpoint, `node result ${node.id}`);
      const bytes = canonicalJsonBytes(result as unknown as JsonValue);
      if (bytes > LIMITS.nodeResultBytes) {
        errors.push(`node result ${node.id} exceeds ${LIMITS.nodeResultBytes} bytes (was ${bytes}); trim \`evidence\`/\`data\` or narrow the node result`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return errors;
  }
  return errors;
}

function blockedProblems(workflow: Workflow, state: Execution, leaf: Frame, outcome: Extract<TaskOutcome, { status: "blocked" }>, planExempt: boolean): string[] {
  const errors = [...outcomeShapeErrors(outcome), ...checkpointErrors(outcome.checkpoint, "checkpoint", planExempt)];
  const contract = contractErrorFor(workflow, outputContractFor(workflow, state, leaf), outcome.checkpoint.data, `checkpoint ${leaf.key}`);
  if (contract) errors.push(contract);
  return errors;
}

function withCheckpoint(state: Execution, key: string, checkpoint: Checkpoint): Execution {
  // Copy-on-write (corr-d1): refusal branches in the runtime must find the
  // input execution untouched, so a refused transition changes nothing.
  const tracked = Object.hasOwn(state.checkpoints, key);
  const next: Execution = {
    ...state,
    checkpoints: { ...state.checkpoints, [key]: checkpoint },
    checkpointOrder: tracked ? state.checkpointOrder : [...state.checkpointOrder, key],
  };
  noteCheckpointCommitted(next, key, checkpoint);
  return next;
}

function planKeyOfNode(node: NodeFrame): string {
  return planKeyOf(node.key);
}

function outputContractFor(workflow: Workflow, state: Execution, leaf: Frame): string | undefined {
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    return block?.kind === "task" ? block.output : undefined;
  }
  if (leaf.kind !== "node") return undefined;
  const execution = state.plans[planKeyOfNode(leaf)];
  const node = execution?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  return node ? workflow.operators.get(node.operator)?.output : undefined;
}

function finishAdvance(workflow: Workflow, state: Execution, stack: readonly Frame[], store?: ArtifactSinkProvider): EngineResult {
  const advanced = advance(workflow, { ...state, stack }, store);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) {
    return { ok: true, state: { ...advanced.state, stack: [], status: "completed" }, effect: { kind: "complete" } };
  }
  return leafEffect(workflow, advanced.state, { kind: "deliver" });
}

/** The script leaf at the top of the stack, when the runtime itself must execute it. */
export function processLeafAt(workflow: Workflow, state: Execution): ProcessLeaf | undefined {
  const staticLeaf = scriptLeafAt(workflow, state);
  if (!staticLeaf) return undefined;
  return { key: staticLeaf.key, blockId: staticLeaf.block.id, script: staticLeaf.block.script, ...(staticLeaf.block.inputs ? { inputs: staticLeaf.block.inputs } : {}) };
}

function runnerOfLeaf(workflow: Workflow, state: Execution, leaf: Frame): RunnerKind {
  if (leaf.kind === "task") return blockOf(workflow, leaf.blockId)?.kind === "script" ? "process" : "agent";
  return "agent";
}
export function enterInvocation(workflow: Workflow, state: Execution, leaf: Frame, status: NodeStatus = "running", attempt?: number): Execution {
  const invocation: NodeInvocation = {
    blockId: leaf.blockId,
    key: leaf.key,
    runner: runnerOfLeaf(workflow, state, leaf),
    status,
    attempt: attempt ?? frameAttempt(leaf),
  };
  const invocations = upsertInvocation(state, leaf.key, invocation);
  return invocations === state.invocations ? state : { ...state, invocations };
}

function leafEffect(workflow: Workflow, state: Execution, fallback: Effect): EngineResult {
  const leaf = state.stack[state.stack.length - 1];
  if (leaf?.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    if (block?.kind === "script") {
      return { ok: true, state: enterInvocation(workflow, state, leaf), effect: { kind: "run-process", key: leaf.key } };
    }
  }
  if (leaf && isAttemptBearingFrame(leaf)) {
    return { ok: true, state: enterInvocation(workflow, state, leaf), effect: fallback };
  }
  return { ok: true, state, effect: fallback };
}

function operatorResultContractError(workflow: Workflow, operator: OperatorDescriptor | undefined, data: JsonValue | undefined, label: string): string | undefined {
  return contractErrorFor(workflow, operator?.output, data, label);
}

function completePlanCreation(workflow: Workflow, state: Execution, leaf: Extract<Frame, { kind: "plan" }>, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const block = blockOf(workflow, leaf.blockId);
  if (!block || block.kind !== "plan") return fail(`frame ${leaf.key} does not name a plan block`);
  const planValue = (outcome.checkpoint.data as { plan?: unknown } | undefined)?.plan;
  if (planValue === undefined) return fail("plan creation completion must carry checkpoint.data.plan");
  const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators));
  if ("errors" in validation) return fail(`invalid plan: ${validation.errors.join("; ")}`);
  const execution: PlanExecution = {
    blockId: block.id,
    plan: validation.plan,
    results: {},
  };
  const planKeyed = withCheckpoint(state, leaf.key, stripPlanPayload(outcome.checkpoint));
  notePlanKeyCreated(planKeyed, block.id, leaf.key);
  const plans = { ...planKeyed.plans, [leaf.key]: execution };
  const stack: Frame[] = [...state.stack.slice(0, -1), { kind: "plan", blockId: block.id, key: leaf.key, mode: "execute" as const, attempt: 1 }];
  return finishAdvance(workflow, enterInvocation(workflow, { ...planKeyed, plans }, leaf, "succeeded"), stack);
}

function stripPlanPayload(checkpoint: Checkpoint): Checkpoint {
  const data = checkpoint.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).plan === undefined) return checkpoint;
  const rest = { ...(data as Record<string, unknown>) };
  delete rest.plan;
  const { data: _planData, ...withoutData } = checkpoint;
  return Object.keys(rest).length > 0
    ? { ...withoutData, data: rest as import("../domain/json.ts").JsonValue }
    : withoutData;
}

function completeNode(workflow: Workflow, state: Execution, leaf: NodeFrame, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const planKey = planKeyOfNode(leaf);
  const execution = state.plans[planKey];
  if (!execution || execution.blockId !== leaf.blockId) return fail(`node frame ${leaf.key} has no plan execution`);
  const node = execution.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  if (!node) return fail(`node ${leaf.nodeId} is not in the active plan`);
  const criteriaError = checkCriteria(node.done, outcome.met ?? []);
  if (criteriaError) return fail(criteriaError);
  const operator = workflow.operators.get(node.operator);
  const contractError = operatorResultContractError(workflow, operator, outcome.checkpoint.data, `node result ${node.id}`);
  if (contractError) return fail(contractError);
  let result: Checkpoint;
  try {
    result = validateCheckpoint(outcome.checkpoint, `node result ${node.id}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const hadCheckpoint = state.checkpoints[leaf.key] !== undefined;
  if (hadCheckpoint) {
    delete (state.checkpoints as Record<string, Checkpoint>)[leaf.key];
    const order = state.checkpointOrder as string[];
    const at = order.indexOf(leaf.key);
    if (at >= 0) order.splice(at, 1);
    noteCheckpointRemoved(state, leaf.key, `${workflow.root.id}/`);
  }
  const completedState = hadCheckpoint ? { ...state } : state;
  const plans = {
    ...completedState.plans,
    [planKey]: {
      ...execution,
      results: { ...execution.results, [node.id]: result },
    },
  };
  return finishAdvance(workflow, enterInvocation(workflow, { ...completedState, plans }, leaf, "succeeded"), state.stack.slice(0, -1));
}

export function start(workflow: Workflow, input: StartInput, store?: ArtifactSinkProvider): EngineResult {
  if (workflow.root.children.length === 0) return fail("workflow has no steps");
  if (Buffer.byteLength(input.target ?? "", "utf8") > LIMITS.targetBytes) {
    return fail(`target exceeds ${LIMITS.targetBytes} bytes; narrow it and start again`);
  }
  const target = (input.target ?? "").trim();
  const base: Execution = {
    workflowName: workflow.name,
    runId: input.runId,
    target,
    status: "active",
    stack: [],
    checkpoints: {},
    checkpointOrder: [],
    plans: {},
    loops: {},
  };
  const entered: Execution = { ...base, stack: [{ kind: "sequence", blockId: workflow.root.id, key: workflow.root.id, index: 0 }] };
  const advanced = advance(workflow, entered, store);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) return fail("workflow has no runnable steps");
  return leafEffect(workflow, advanced.state, { kind: "deliver" });
}

export function transition(workflow: Workflow, state: Execution, event: WorkflowEvent, store?: ArtifactSinkProvider): EngineResult {
  if (state.status !== "active") return fail("execution is not active");
  if (event.type === "process-exit") {
    return applyProcessExit(workflow, state, event, store);
  }
  const outcome = event.outcome;
  const leaf = state.stack[state.stack.length - 1];
  // Keyed outcomes (C1): an outcome applies only to the position it names, so a
  // duplicated or stale tool result can never commit another position.
  if (leaf && outcome.key !== leaf.key) {
    return fail(`outcome key ${outcome.key} does not match position ${leaf.key}`);
  }
  const planExempt = leaf?.kind === "plan" && leaf.mode === "create";
  if (leaf?.kind === "task" && blockOf(workflow, leaf.blockId)?.kind === "script") {
    return fail(`position ${leaf.key} is a script step; the runtime executes it and it does not accept transitions`);
  }
  if (!leaf || !isLeafFrame(leaf)) {
    const error = joined([...outcomeShapeErrors(outcome), ...checkpointErrors(outcome.checkpoint, "checkpoint", false)]);
    return fail(error ?? "execution has no current leaf task");
  }
  const problems = outcome.status === "completed"
    ? completedProblems(workflow, state, leaf, outcome, planExempt)
    : outcome.status === "blocked"
      ? blockedProblems(workflow, state, leaf, outcome, planExempt)
      : [...outcomeShapeErrors(outcome), ...checkpointErrors(outcome.checkpoint, "checkpoint", planExempt)];
  const invalid = joined(problems);
  if (invalid) return fail(invalid);
  switch (outcome.status) {
    case "blocked": {
      const checkpoint = leaf.kind === "plan" ? stripPlanPayload(outcome.checkpoint) : outcome.checkpoint;
      const waiting = enterInvocation(workflow, state, leaf, "waiting");
      return { ok: true, state: withCheckpoint(waiting, leaf.key, checkpoint), effect: { kind: "stay" } };
    }
    case "needs-work":
      return applyNeedsWork(workflow, state, outcome);
    case "completed": {
      if (leaf.kind === "plan") return completePlanCreation(workflow, state, leaf, outcome);
      if (leaf.kind === "node") return completeNode(workflow, state, leaf, outcome);
      const committed = withCheckpoint(enterInvocation(workflow, state, leaf, "succeeded"), leaf.key, outcome.checkpoint);
      const popped: Execution = { ...committed, stack: state.stack.slice(0, -1) };
      return finishAdvance(workflow, popped, popped.stack, store);
    }
  }
}

function applyProcessExit(workflow: Workflow, state: Execution, event: ProcessExitEvent, store?: ArtifactSinkProvider): EngineResult {
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || leaf.kind !== "task") return fail(`process exit ${event.key} has no process leaf`);
  if (leaf.key !== event.key) return fail(`process exit key ${event.key} does not match the process leaf ${leaf.key}`);
  const block = blockOf(workflow, leaf.blockId);
  if (block?.kind !== "script") return fail(`frame ${leaf.key} is not a script position`);
  const spec = block.script;
  const output = processOutput(spec, event);
  if ("error" in output) return scriptFailure(workflow, state, leaf, block, output.error);
  const contract = contractErrorFor(workflow, block.output, output.value, `script ${leaf.key} output`);
  if (contract) return scriptFailure(workflow, state, leaf, block, contract);
  let checkpoint: Checkpoint = { summary: clipSummary(`Script ${block.id} exited ${event.exit.code}.${output.truncation}`), data: output.value };
  if (canonicalJsonBytes(checkpoint as unknown as JsonValue) > LIMITS.checkpointBytes) {
    const ref = event.store.publishJson("output", output.value);
    checkpoint = { summary: clipSummary(`Script ${block.id} exited ${event.exit.code}; its ${ref.size}-byte output was published to the artifact store as ${ref.checksum}.${output.truncation}`), data: ref as unknown as JsonValue };
  }
  try {
    validateCheckpoint(checkpoint, `script ${leaf.key}`);
  } catch (error) {
    return scriptFailure(workflow, state, leaf, block, error instanceof Error ? error.message : String(error));
  }
  const succeeded = enterInvocation(workflow, withCheckpoint(state, leaf.key, checkpoint), leaf, "succeeded");
  const popped: Execution = { ...succeeded, stack: state.stack.slice(0, -1) };
  return finishAdvance(workflow, popped, popped.stack, store);
}

function scriptFailure(workflow: Workflow, state: Execution, leaf: Extract<Frame, TaskFrame>, block: ScriptBlock, reason: string): EngineResult {
  const checkpoint: Checkpoint = { summary: clipSummary(`Script ${block.id} ${reason}.`) };
  const result = applyNeedsWork(workflow, state, { checkpoint, issues: [{ target: block.id, reason }] });
  if (!result.ok || result.effect.kind !== "stay") return result;
  return { ...result, state: enterInvocation(workflow, result.state, leaf, "waiting") };
}

interface PositionInfo {
  readonly type: "task" | "plan-create" | "node";
  readonly key: string;
  readonly attempt: number;
  readonly task?: TaskBlock;
  readonly plan?: PlanBlock;
  readonly node?: import("../planning/schema.ts").PlanNode;
  readonly execution?: PlanExecution;
  readonly stack: readonly Frame[];
}

export function currentPosition(workflow: Workflow, state: Execution): PositionInfo | undefined {
  if (state.status !== "active") return undefined;
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || !isLeafFrame(leaf)) return undefined;
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    if (block?.kind === "task") {
      return { type: "task", key: leaf.key, attempt: leaf.attempt, task: block, stack: state.stack };
    }
    return undefined;
  }
  if (leaf.kind === "plan") {
    const block = blockOf(workflow, leaf.blockId);
    if (block?.kind === "plan") {
      return { type: "plan-create", key: leaf.key, attempt: leaf.attempt, plan: block, execution: state.plans[leaf.key], stack: state.stack };
    }
    return undefined;
  }
  if (leaf.kind === "node") {
    const block = blockOf(workflow, leaf.blockId);
    const planKey = planKeyOf(leaf.key);
    const execution = state.plans[planKey];
    const node = execution?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
    if (block?.kind === "plan" && execution && node) {
      return { type: "node", key: leaf.key, attempt: leaf.attempt, plan: block, node, execution, stack: state.stack };
    }
    return undefined;
  }
  return undefined;
}
