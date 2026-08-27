import type { Checkpoint } from "../domain/checkpoint.ts";
import { validateCheckpoint } from "../domain/checkpoint.ts";
import type { Execution, Frame, LoopFrame, LoopState, NodeFrame, PlanExecution, SequenceFrame, TaskFrame } from "../domain/execution.ts";
import { applyNeedsWork } from "./recovery.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import { planKeyOf, scopeKey } from "../domain/keys.ts";
import { evaluateGuard, skipReason, type GuardClause } from "../domain/guard.ts";
import type { LoopBlock, PlanBlock, SequenceBlock, TaskBlock, Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { resolveBinding } from "../domain/artifacts.ts";
import { canonicalJson, canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { firstIncompleteNode } from "../planning/graph.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";

export type Issue = {
  readonly target: string;
  readonly reason: string;
};

export type TaskOutcome =
  | { readonly status: "completed"; readonly met?: readonly string[]; readonly checkpoint: Checkpoint }
  | { readonly status: "needs-work"; readonly checkpoint: Checkpoint; readonly issues?: readonly Issue[] }
  | { readonly status: "blocked"; readonly checkpoint: Checkpoint };

type WorkflowEvent =
  | { readonly type: "outcome"; readonly outcome: TaskOutcome }
  | { readonly type: "abort" };

export type Effect =
  | { readonly kind: "deliver" }
  | { readonly kind: "stay" }
  | { readonly kind: "complete" }
  | { readonly kind: "aborted" };

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

function isLeafFrame(frame: Frame): boolean {
  return frame.kind === "task" || frame.kind === "node" || (frame.kind === "plan" && frame.mode === "create");
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
    case "sequence":
      stack.push({ kind: "sequence", blockId: child.id, key, index: 0 });
      return { leaf: false };
    case "loop": {
      const existing = state.loops[key];
      if (existing) {
        stack.push({ kind: "loop", blockId: child.id, key, scopeId: `loop[${existing.iteration}]` });
        return { leaf: false };
      }
      let items: readonly JsonValue[] | undefined;
      if (child.mode === "for-each") {
        const resolved = resolveBinding(workflow, view, child.itemsBinding!);
        if (!resolved.ok) return { error: `loop ${child.id} could not resolve items: ${resolved.error}` };
        if (!Array.isArray(resolved.value)) return { error: `loop ${child.id} items must resolve to a list` };
        if (resolved.value.length > child.maxIterations) {
          return { error: `loop ${child.id} has ${resolved.value.length} items, above its cap of ${child.maxIterations}` };
        }
        items = resolved.value as readonly JsonValue[];
      }
      stack.push({ kind: "loop", blockId: child.id, key, scopeId: "loop[1]" });
      return {
        leaf: false,
        loops: { ...state.loops, [key]: { iteration: 1, ...(items ? { items } : {}) } },
      };
    }
    case "plan": {
      const existing = state.plans[key];
      if (existing && !existing.awaitingPlan && firstIncompleteNode(existing)) {
        stack.push({ kind: "plan", blockId: child.id, key, mode: "execute", attempt: 1 });
        return { leaf: false };
      }
      if (existing && existing.awaitingPlan) {
        stack.push({ kind: "plan", blockId: child.id, key, mode: "create", attempt: 1 });
        return { leaf: true };
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
  const max = LIMITS.checkpointSummaryBytes - 64;
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  let clipped = value;
  while (Buffer.byteLength(clipped, "utf8") > max - 3) clipped = clipped.slice(0, Math.max(0, clipped.length - 16));
  return `${clipped}...`;
}

function skipBlock(state: Execution, parentKey: string, guard: GuardClause, blockId: string, isPlan: boolean): Execution {
  const key = childKey(parentKey, blockId);
  const withCp = withCheckpoint(state, key, { summary: clipSummary(skipReason(guard)), skipped: true });
  if (!isPlan) return withCp;
  const plans = { ...withCp.plans };
  for (const [planKey, execution] of Object.entries(plans)) {
    if (execution.blockId === blockId) delete plans[planKey];
  }
  return { ...withCp, plans };
}

function iterationSummaries(state: Execution, loopKey: string, iterations: number): readonly string[] {
  const summaries: string[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const scoped = scopeKey(loopKey, iteration);
    for (const [key, checkpoint] of Object.entries(state.checkpoints)) {
      if (key.startsWith(`${scoped}/`)) summaries.push(clipSummary(checkpoint.summary));
    }
  }
  return summaries.slice(0, LIMITS.checkpointListItems);
}

function finishLoop(state: Execution, loopKey: string, block: LoopBlock): { state: Execution } | { error: string } {
  const loopState = state.loops[loopKey];
  if (!loopState) return { error: `loop frame ${loopKey} has no loop state` };
  const iterations = block.mode === "for-each" ? loopState.items?.length ?? 0 : loopState.iteration;
  const summaries = iterationSummaries(state, loopKey, iterations);
  const data: Record<string, JsonValue> = { mode: block.mode, iterations };
  if (loopState.exhausted) data.exhausted = true;
  if (summaries.length) data.results = [...summaries];
  const checkpoint: Checkpoint = {
    summary: clipSummary(
      loopState.exhausted
        ? `Loop ${block.id} reached its cap of ${block.maxIterations} iterations without the condition holding.`
        : `Loop ${block.id} completed ${iterations} iteration${iterations === 1 ? "" : "s"}.`,
    ),
    data,
  };
  try {
    validateCheckpoint(checkpoint, `loop ${loopKey}`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const loops = { ...state.loops };
  delete loops[loopKey];
  return { state: withCheckpoint({ ...state, loops }, loopKey, checkpoint) };
}

function afterBodyComplete(workflow: Workflow, state: Execution, loopFrame: LoopFrame): { state: Execution } | { error: string } {
  const loopKey = loopFrame.key;
  const block = loopAt(workflow, loopFrame.blockId);
  if (!block) return { error: `loop frame ${loopKey} does not name a loop` };
  const loopState = state.loops[loopKey];
  if (!loopState) return { error: `loop frame ${loopKey} has no loop state` };
  const completed = loopState.iteration;
  if (block.mode === "for-each") {
    return { state: { ...state, loops: { ...state.loops, [loopKey]: { ...loopState, iteration: completed + 1 } } } };
  }
  const guard = evaluateGuard(workflow, state, block.condition!);
  if (!guard.ok) return { error: `loop ${block.id} condition could not resolve: ${guard.error}` };
  if (guard.holds) {
    return { state: { ...state, loops: { ...state.loops, [loopKey]: { ...loopState, done: true } } } };
  }
  if (completed >= block.maxIterations) {
    return { state: { ...state, loops: { ...state.loops, [loopKey]: { ...loopState, done: true, exhausted: true } } } };
  }
  return { state: { ...state, loops: { ...state.loops, [loopKey]: { ...loopState, iteration: completed + 1 } } } };
}

export function advance(workflow: Workflow, state: Execution): AdvanceResult {
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
          const parent = stack[stack.length - 1];
          if (parent?.kind === "loop") {
            const advanced = afterBodyComplete(workflow, working, parent);
            if ("error" in advanced) return { ok: false, error: advanced.error };
            working = advanced.state;
            const loopState = working.loops[parent.key];
            if (loopState && !loopState.done) stack[stack.length - 1] = { ...parent, scopeId: `loop[${loopState.iteration}]` };
          }
          continue;
        }
        const advanced: SequenceFrame = { ...top, index: top.index + 1 };
        stack[topIndex] = advanced;
        if ((child.kind === "task" || child.kind === "plan" || child.kind === "loop") && child.guard) {
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
        if (loopState.iteration > block.maxIterations) {
          return { ok: false, error: `loop ${block.id} exceeded its iteration cap of ${block.maxIterations}` };
        }
        if (loopState.done || (block.mode === "for-each" && loopState.iteration > (loopState.items?.length ?? 0))) {
          const finished = finishLoop(working, top.key, block);
          if ("error" in finished) return { ok: false, error: finished.error };
          stack.pop();
          working = finished.state;
          continue;
        }
        const scoped = scopeKey(top.key, loopState.iteration);
        stack.push({ kind: "sequence", blockId: block.body.id, key: scoped, index: 0 });
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

function validateOutcome(outcome: TaskOutcome, planCreate: boolean): string | undefined {
  const raw = outcome as { met?: unknown; issues?: unknown };
  if (outcome.status !== "completed" && raw.met !== undefined) return "met is only valid with status \"completed\"";
  if (outcome.status !== "needs-work" && raw.issues !== undefined) return "issues is only valid with status \"needs-work\"";
  if (raw.met !== undefined) {
    if (!Array.isArray(raw.met)) return "met must be a list of criterion ids";
    for (const id of raw.met) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) return "met entries must match ^[a-z][a-z0-9-]*$";
    }
  }
  if (raw.issues !== undefined) {
    if (!Array.isArray(raw.issues)) return "issues must be a list";
    for (const issue of raw.issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) return "issues entries must be objects";
      if (typeof issue.target !== "string" || !issue.target.trim()) return "issues entries need a non-empty target";
      if (typeof issue.reason !== "string" || !issue.reason.trim()) return "issues entries need a non-empty reason";
    }
  }
  try {
    validateCheckpoint(outcome.checkpoint, "checkpoint", planCreate);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function commitCheckpoint(state: Execution, key: string, checkpoint: Checkpoint): Execution["checkpoints"] {
  return { ...state.checkpoints, [key]: checkpoint };
}

function withCheckpoint(state: Execution, key: string, checkpoint: Checkpoint): Execution {
  const checkpoints = commitCheckpoint(state, key, checkpoint);
  const checkpointOrder = state.checkpointOrder.includes(key) ? state.checkpointOrder : [...state.checkpointOrder, key];
  return { ...state, checkpoints, checkpointOrder };
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

function finishAdvance(workflow: Workflow, state: Execution, stack: readonly Frame[]): EngineResult {
  const advanced = advance(workflow, { ...state, stack });
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) {
    return { ok: true, state: { ...advanced.state, stack: [], status: "completed" }, effect: { kind: "complete" } };
  }
  return { ok: true, state: advanced.state, effect: { kind: "deliver" } };
}

function resultOperatorsFor(previous: PlanExecution | undefined): { readonly operators: Record<string, string>; readonly error?: string } {
  const operators = { ...(previous?.resultOperators ?? {}) };
  if (previous) {
    for (const id of Object.keys(operators)) {
      if (previous.results[id] === undefined) return { operators, error: `result metadata ${id} has no matching result` };
    }
    for (const node of previous.plan.nodes) {
      if (!Object.hasOwn(previous.results, node.id)) continue;
      if (operators[node.id] !== undefined && operators[node.id] !== node.operator) {
        return { operators, error: `result ${node.id} has conflicting producer metadata` };
      }
      operators[node.id] = node.operator;
    }
  }
  return { operators };
}

function hasContractBearingOperator(workflow: Workflow, operators: readonly string[]): boolean {
  return operators.some((id) => workflow.operators.get(id)?.output !== undefined);
}

function retainedResultError(workflow: Workflow, block: PlanBlock, previous: PlanExecution | undefined, resultOperators: Readonly<Record<string, string>>): string | undefined {
  if (!previous) return undefined;
  const requiresMetadata = hasContractBearingOperator(workflow, block.operators);
  for (const [id, result] of Object.entries(previous.results)) {
    const operatorId = resultOperators[id];
    if (!operatorId) {
      if (requiresMetadata) return `retained result ${id} has no producer metadata`;
      continue;
    }
    const operator = workflow.operators.get(operatorId);
    if (!operator) {
      if (requiresMetadata) return `retained result ${id} uses an unknown producer ${operatorId}`;
      continue;
    }
    if (!block.operators.includes(operatorId)) return `retained result ${id} uses operator ${operatorId}, which is not trusted by ${block.id}`;
    const problem = contractErrorFor(workflow, operator.output, result.data, `retained result ${id}`);
    if (problem) return problem;
  }
  return undefined;
}

function completePlanCreation(workflow: Workflow, state: Execution, leaf: Extract<Frame, { kind: "plan" }>, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const block = blockOf(workflow, leaf.blockId);
  if (!block || block.kind !== "plan") return fail(`frame ${leaf.key} does not name a plan block`);
  const planValue = (outcome.checkpoint.data as { plan?: unknown } | undefined)?.plan;
  if (planValue === undefined) return fail("plan creation completion must carry checkpoint.data.plan");
  const previous = state.plans[leaf.key];
  const resultMetadata = resultOperatorsFor(previous);
  if (resultMetadata.error) return fail(resultMetadata.error);
  const retainedError = retainedResultError(workflow, block, previous, resultMetadata.operators);
  if (retainedError) return fail(retainedError);
  const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators, new Set(Object.keys(previous?.results ?? {}))));
  if ("errors" in validation) return fail(`invalid plan: ${validation.errors.join("; ")}`);
  const execution: PlanExecution = {
    blockId: block.id,
    revision: previous ? previous.revision : 1,
    replans: previous ? previous.replans : 0,
    invalidations: previous ? previous.invalidations : 0,
    plan: validation.plan,
    results: previous ? previous.results : {},
    ...(Object.keys(resultMetadata.operators).length > 0 ? { resultOperators: resultMetadata.operators } : {}),
  };
  const planKeyed = withCheckpoint(state, leaf.key, stripPlanPayload(outcome.checkpoint));
  const plans = { ...planKeyed.plans, [leaf.key]: execution };
  const stack: Frame[] = [...state.stack.slice(0, -1), { kind: "plan", blockId: block.id, key: leaf.key, mode: "execute" as const, attempt: 1 }];
  return finishAdvance(workflow, { ...planKeyed, plans }, stack);
}

function stripPlanPayload(checkpoint: Checkpoint): Checkpoint {
  const data = checkpoint.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).plan === undefined) return checkpoint;
  const objectData = data as Record<string, unknown>;
  const rest = { ...objectData };
  delete rest.plan;
  const next: { summary: string; evidence?: string[]; decisions?: string[]; unknowns?: string[]; data?: import("../domain/json.ts").JsonValue } = { summary: checkpoint.summary };
  if (checkpoint.evidence) next.evidence = [...checkpoint.evidence];
  if (checkpoint.decisions) next.decisions = [...checkpoint.decisions];
  if (checkpoint.unknowns) next.unknowns = [...checkpoint.unknowns];
  if (Object.keys(rest).length > 0) next.data = rest as import("../domain/json.ts").JsonValue;
  return next;
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
  const contractError = contractErrorFor(workflow, operator?.output, outcome.checkpoint.data, `node result ${node.id}`);
  if (contractError) return fail(contractError);
  const { checkpoint } = outcome;
  let result: Checkpoint;
  try {
    result = validateCheckpoint(checkpoint, `node result ${node.id}`);
    if (canonicalJsonBytes(result as unknown as JsonValue) > LIMITS.nodeResultBytes) throw new Error(`node result ${node.id} exceeds ${LIMITS.nodeResultBytes} bytes`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const plans = {
    ...state.plans,
    [planKey]: {
      ...execution,
      results: { ...execution.results, [node.id]: result },
      resultOperators: { ...(execution.resultOperators ?? {}), [node.id]: node.operator },
    },
  };
  return finishAdvance(workflow, { ...state, plans }, state.stack.slice(0, -1));
}

export function start(workflow: Workflow, input: StartInput): EngineResult {
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
  const advanced = advance(workflow, entered);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) return fail("workflow has no runnable steps");
  return { ok: true, state: advanced.state, effect: { kind: "deliver" } };
}

export function transition(workflow: Workflow, state: Execution, event: WorkflowEvent): EngineResult {
  if (state.status !== "active") return fail("execution is not active");
  if (event.type === "abort") {
    return { ok: true, state: { ...state, status: "aborted" }, effect: { kind: "aborted" } };
  }
  const outcome = event.outcome;
  const leaf = state.stack[state.stack.length - 1];
  const invalid = validateOutcome(outcome, leaf?.kind === "plan" && leaf.mode === "create");
  if (invalid) return fail(invalid);
  if (!leaf || !isLeafFrame(leaf)) return fail("execution has no current leaf task");
  switch (outcome.status) {
    case "blocked": {
      const checkpointError = contractErrorFor(workflow, outputContractFor(workflow, state, leaf), outcome.checkpoint.data, `checkpoint ${leaf.key}`);
      if (checkpointError) return fail(checkpointError);
      const checkpoint = leaf.kind === "plan" ? stripPlanPayload(outcome.checkpoint) : outcome.checkpoint;
      return { ok: true, state: withCheckpoint(state, leaf.key, checkpoint), effect: { kind: "stay" } };
    }
    case "needs-work":
      return applyNeedsWork(workflow, state, outcome);
    case "completed": {
      if (leaf.kind === "plan") return completePlanCreation(workflow, state, leaf, outcome);
      if (leaf.kind === "node") return completeNode(workflow, state, leaf, outcome);
      if (leaf.kind !== "task") return fail("completion for this position is not supported");
      const block = blockOf(workflow, leaf.blockId);
      if (!block || block.kind !== "task") return fail(`frame ${leaf.key} does not name a task`);
      const criteriaError = checkCriteria(block.done ?? [], outcome.met ?? []);
      if (criteriaError) return fail(criteriaError);
      const contractError = contractErrorFor(workflow, block.output, outcome.checkpoint.data, `task ${leaf.key} output`);
      if (contractError) return fail(contractError);
      const committed = withCheckpoint(state, leaf.key, outcome.checkpoint);
      const popped: Execution = { ...committed, stack: state.stack.slice(0, -1) };
      return finishAdvance(workflow, popped, popped.stack);
    }
  }
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
