import type { Checkpoint } from "../domain/checkpoint.ts";
import { checkpointErrors, validateCheckpoint } from "../domain/checkpoint.ts";
import type { Execution, Frame, LoopFrame, LoopState, NodeFrame, PlanExecution, SequenceFrame, TaskFrame } from "../domain/execution.ts";
import { applyNeedsWork } from "./recovery.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import { lastSegment, planKeyOf, scopeKey } from "../domain/keys.ts";
import { evaluateGuard, skipReason, type GuardClause } from "../domain/guard.ts";
import type { LoopBlock, OperatorDescriptor, PlanBlock, ScriptBlock, ScriptSpec, SequenceBlock, TaskBlock, Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { type NodeInvocation, type NodeStatus, type RunnerKind } from "../domain/node.ts";
import { upsertInvocation } from "../domain/execution.ts";
import { isArtifactRef, resolveBinding, type ArtifactRef, type ArtifactSink, type ArtifactSinkProvider } from "../domain/artifacts.ts";
import { canonicalJsonBytes, isJsonValue, type JsonValue } from "../domain/json.ts";
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

function isLeafFrame(frame: Frame): boolean {
  return frame.kind === "task" || frame.kind === "node" || (frame.kind === "plan" && frame.mode === "create");
}

interface ProcessLeaf {
  readonly key: string;
  readonly blockId: string;
  readonly script: ScriptSpec;
  readonly inputs?: ScriptBlock["inputs"];
  readonly planKey?: string;
  readonly dependsOn?: readonly string[];
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

function utf8Preview(value: string, max: number): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  let clipped = value;
  while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > max - 3) clipped = clipped.slice(0, Math.max(0, clipped.length - 16));
  return `${clipped}...`;
}

function clipSummary(value: string): string {
  return utf8Preview(value, LIMITS.checkpointSummaryBytes - 64);
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

/**
 * The loop aggregate has one fixed shape: mode, iteration count, and per-iteration records
 * whose outputs are artifact references into the run's store. The schema never varies with
 * output size, so downstream consumers always know what a binding resolves to.
 */
function finishLoop(state: Execution, loopKey: string, block: LoopBlock, store: ArtifactSinkProvider): { state: Execution } | { error: string } {
  const loopState = state.loops[loopKey];
  if (!loopState) return { error: `loop frame ${loopKey} has no loop state` };
  const iterations = block.mode === "for-each" ? loopState.items?.length ?? 0 : loopState.iteration;
  const sink = store.sinkFor(loopKey);
  const results: JsonValue[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const record: Record<string, JsonValue> = { iteration };
    const item = loopState.items?.[iteration - 1];
    if (block.mode === "for-each" && item !== undefined) record.item = item;
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
  const data: Record<string, JsonValue> = { mode: block.mode, iterations };
  if (loopState.exhausted) data.exhausted = true;
  data.results = results as JsonValue;
  const summaryText = loopState.exhausted
    ? `Loop ${block.id} reached its cap of ${block.maxIterations} iterations without the condition holding.`
    : `Loop ${block.id} completed ${iterations} iteration${iterations === 1 ? "" : "s"}.`;
  const checkpoint: Checkpoint = { summary: clipSummary(summaryText), data: data as JsonValue };
  const errors = checkpointErrors(checkpoint, `loop ${loopKey}`);
  if (errors.length > 0) return { error: joined(errors) ?? `loop ${loopKey} aggregate exceeded its checkpoint budget` };
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
        if ((child.kind === "task" || child.kind === "plan" || child.kind === "loop" || child.kind === "script") && child.guard) {
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
        if (loopState.done || (block.mode === "for-each" && loopState.iteration > (loopState.items?.length ?? 0))) {
          if (!store) return { ok: false, error: `loop ${block.id} cannot record its aggregate: the run has no artifact store` };
          const finished = finishLoop(working, top.key, block, store);
          if ("error" in finished) return { ok: false, error: finished.error };
          stack.pop();
          working = finished.state;
          continue;
        }
        if (loopState.iteration > block.maxIterations) {
          return { ok: false, error: `loop ${block.id} exceeded its iteration cap of ${block.maxIterations}` };
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
    const previous = state.plans[leaf.key];
    const metadata = resultOperatorsFor(previous);
    if (metadata.error) {
      errors.push(metadata.error);
      return errors;
    }
    const retained = retainedResultError(workflow, block, previous, metadata.operators);
    if (retained) errors.push(retained);
    const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators, new Set(Object.keys(previous?.results ?? {}))));
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

function finishAdvance(workflow: Workflow, state: Execution, stack: readonly Frame[], store?: ArtifactSinkProvider): EngineResult {
  const advanced = advance(workflow, { ...state, stack }, store);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) {
    return { ok: true, state: { ...advanced.state, stack: [], status: "completed" }, effect: { kind: "complete" } };
  }
  return leafEffect(workflow, advanced.state, { kind: "deliver" });
}

/** The script body of a plan node's operator, when that operator is process-backed. */
function operatorScriptOf(workflow: Workflow, state: Execution, leaf: NodeFrame): { nodeId: string; operator: string; script: ScriptSpec; dependsOn?: readonly string[] } | undefined {
  const execution = state.plans[planKeyOfNode(leaf)];
  if (!execution || execution.blockId !== leaf.blockId) return undefined;
  const node = execution.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  const script = node ? workflow.operators.get(node.operator)?.script : undefined;
  return node && script ? { nodeId: node.id, operator: node.operator, script, ...(node.dependsOn ? { dependsOn: node.dependsOn } : {}) } : undefined;
}

export function processLeafAt(workflow: Workflow, state: Execution): ProcessLeaf | undefined {
  const staticLeaf = scriptLeafAt(workflow, state);
  if (staticLeaf) {
    return { key: staticLeaf.key, blockId: staticLeaf.block.id, script: staticLeaf.block.script, ...(staticLeaf.block.inputs ? { inputs: staticLeaf.block.inputs } : {}) };
  }
  if (state.status !== "active") return undefined;
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || leaf.kind !== "node") return undefined;
  const resolved = operatorScriptOf(workflow, state, leaf);
  return resolved ? { key: leaf.key, planKey: planKeyOfNode(leaf), blockId: leaf.blockId, script: resolved.script, ...(resolved.dependsOn ? { dependsOn: resolved.dependsOn } : {}) } : undefined;
}

function runnerOfLeaf(workflow: Workflow, state: Execution, leaf: Frame): RunnerKind {
  if (leaf.kind === "task") return blockOf(workflow, leaf.blockId)?.kind === "script" ? "process" : "agent";
  if (leaf.kind === "node") return operatorScriptOf(workflow, state, leaf) ? "process" : "agent";
  return "agent";
}

export function enterInvocation(workflow: Workflow, state: Execution, leaf: Frame, status: NodeStatus = "running", attempt?: number): Execution {
  const invocation: NodeInvocation = {
    blockId: leaf.blockId,
    key: leaf.key,
    runner: runnerOfLeaf(workflow, state, leaf),
    status,
    attempt: attempt ?? ("attempt" in leaf ? leaf.attempt : 1),
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
  if (leaf && (leaf.kind === "task" || leaf.kind === "plan" || leaf.kind === "node")) {
    return { ok: true, state: enterInvocation(workflow, state, leaf), effect: fallback };
  }
  return { ok: true, state, effect: fallback };
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

function operatorResultContractError(workflow: Workflow, operator: OperatorDescriptor | undefined, data: JsonValue | undefined, label: string): string | undefined {
  return operator?.script && isArtifactRef(data) ? undefined : contractErrorFor(workflow, operator?.output, data, label);
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
    const problem = operatorResultContractError(workflow, operator, result.data, `retained result ${id}`);
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
  return finishAdvance(workflow, enterInvocation(workflow, { ...planKeyed, plans }, leaf, "succeeded"), stack);
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
  const contractError = operatorResultContractError(workflow, operator, outcome.checkpoint.data, `node result ${node.id}`);
  if (contractError) return fail(contractError);
  let result: Checkpoint;
  try {
    result = validateCheckpoint(outcome.checkpoint, `node result ${node.id}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const checkpoints = { ...state.checkpoints };
  delete checkpoints[leaf.key];
  const completedState = state.checkpoints[leaf.key] === undefined
    ? state
    : { ...state, checkpoints, checkpointOrder: state.checkpointOrder.filter((key) => key !== leaf.key) };
  const plans = {
    ...completedState.plans,
    [planKey]: {
      ...execution,
      results: { ...execution.results, [node.id]: result },
      resultOperators: { ...(execution.resultOperators ?? {}), [node.id]: node.operator },
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
  const planExempt = leaf?.kind === "plan" && leaf.mode === "create";
  if (leaf?.kind === "task" && blockOf(workflow, leaf.blockId)?.kind === "script") {
    return fail(`position ${leaf.key} is a script step; the runtime executes it and it does not accept transitions`);
  }
  if (leaf?.kind === "node" && operatorScriptOf(workflow, state, leaf)) {
    return fail(`position ${leaf.key} is a process operator node; the runtime executes it and it does not accept transitions`);
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

interface ProcessExitEvent {
  readonly type: "process-exit";
  readonly key: string;
  readonly exit: { readonly code?: number; readonly signal?: string; readonly timedOut: boolean; readonly stdout: string; readonly stderr: string; readonly truncated: boolean; readonly spawnError?: string };
  readonly files?: readonly ArtifactRef[];
  readonly captureError?: string;
  readonly store?: ArtifactSink;
}

const TEXT_STDOUT_BUDGET_BYTES = LIMITS.checkpointBytes - 256;

function clipToByteBudget(text: string, budget: number): string {
  let clipped = text;
  while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > budget) clipped = clipped.slice(0, -16);
  return clipped;
}

/** Adds side outputs (stderr, captured files) to the stdout-derived data without losing non-object stdout values. */
function mergeOutputSides(base: JsonValue, sides: Record<string, JsonValue>): JsonValue {
  if (Object.keys(sides).length === 0) return base;
  if (typeof base === "object" && base !== null && !Array.isArray(base)) return { ...base, ...sides };
  const wrapped: Record<string, JsonValue> = base === null ? {} : { stdout: base };
  return { ...wrapped, ...sides };
}

function capturedFilesSides(files: readonly ArtifactRef[] | undefined): Record<string, JsonValue> {
  if (!files || files.length === 0) return {};
  const refs: Record<string, JsonValue> = {};
  for (const ref of files) refs[ref.output] = ref as unknown as JsonValue;
  return { files: refs };
}

/** Applies the configured stderr mode: none keeps stderr diagnostic-only, text stores it, json parses it. */
function scriptStderrValue(spec: ScriptSpec, exit: ProcessExitEvent["exit"], store?: ArtifactSink): { sides: Record<string, JsonValue>; clipped?: boolean } | { error: string } {
  if (spec.stderr === "none") return { sides: {} };
  if (spec.stderr === "text") {
    const text = exit.stderr;
    if (Buffer.byteLength(text, "utf8") <= TEXT_STDOUT_BUDGET_BYTES) return { sides: { stderr: text } };
    if (!store) return { sides: { stderr: clipToByteBudget(text, TEXT_STDOUT_BUDGET_BYTES), stderrTruncated: true }, clipped: true };
    const ref = store.publishText("stderr", text);
    return { sides: { stderr: utf8Preview(text, 192), stderrArtifact: ref as unknown as JsonValue }, clipped: true };
  }
  try {
    const parsed = JSON.parse(exit.stderr) as unknown;
    if (!isJsonValue(parsed)) return { error: "stderr is not a JSON value" };
    return { sides: { stderr: parsed } };
  } catch (error) {
    return { error: `stderr is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function scriptStdoutValue(spec: ScriptSpec, exit: ProcessExitEvent["exit"], store?: ArtifactSink): { value: JsonValue; clipped?: boolean } | { error: string } {
  let base: JsonValue = {};
  let stdoutClipped = false;
  if (spec.stdout === "json") {
    try {
      const parsed = JSON.parse(exit.stdout) as unknown;
      if (!isJsonValue(parsed)) return { error: "stdout is not a JSON value" };
      base = parsed;
    } catch (error) {
      return { error: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  } else if (spec.stdout === "text") {
    const stdout = exit.stdout;
    if (Buffer.byteLength(stdout, "utf8") <= TEXT_STDOUT_BUDGET_BYTES) {
      base = { stdout };
    } else if (!store) {
      base = { stdout: clipToByteBudget(stdout, TEXT_STDOUT_BUDGET_BYTES), stdoutTruncated: true };
      stdoutClipped = true;
    } else {
      const ref = store.publishText("output", stdout);
      base = { stdout: utf8Preview(stdout, 192), stdoutTruncated: true, artifact: ref as unknown as JsonValue };
      stdoutClipped = true;
    }
  }
  const stderr = scriptStderrValue(spec, exit, store);
  if ("error" in stderr) return stderr;
  return { value: mergeOutputSides(base, stderr.sides), ...(stdoutClipped || stderr.clipped ? { clipped: true } : {}) };
}

function processOutput(spec: ScriptSpec, event: ProcessExitEvent): { value: JsonValue; truncation: string } | { error: string } {
  if (event.captureError !== undefined) return { error: event.captureError };
  const accepted = !event.exit.timedOut && event.exit.code !== undefined && spec.acceptedExitCodes.includes(event.exit.code);
  if (!accepted) return { error: exitFailureReason(spec, event.exit) };
  const parsed = scriptStdoutValue(spec, event.exit, event.store);
  if ("error" in parsed) return parsed;
  return {
    value: mergeOutputSides(parsed.value, capturedFilesSides(event.files)),
    truncation: event.exit.truncated || parsed.clipped ? " (captured output was truncated)" : "",
  };
}

function applyProcessExit(workflow: Workflow, state: Execution, event: ProcessExitEvent, store?: ArtifactSinkProvider): EngineResult {
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || (leaf.kind !== "task" && leaf.kind !== "node")) return fail(`process exit ${event.key} has no process leaf`);
  if (leaf.key !== event.key) return fail(`process exit key ${event.key} does not match the process leaf ${leaf.key}`);
  if (leaf.kind === "node") return applyOperatorExit(workflow, state, leaf, event);
  const block = blockOf(workflow, leaf.blockId);
  if (block?.kind !== "script") return fail(`frame ${leaf.key} is not a script position`);
  const spec = block.script;
  const output = processOutput(spec, event);
  if ("error" in output) return scriptFailure(workflow, state, leaf, block, output.error);
  const contract = contractErrorFor(workflow, block.output, output.value, `script ${leaf.key} output`);
  if (contract) return scriptFailure(workflow, state, leaf, block, contract);
  let checkpoint: Checkpoint = { summary: clipSummary(`Script ${block.id} exited ${event.exit.code}.${output.truncation}`), data: output.value };
  if (event.store && canonicalJsonBytes(checkpoint as unknown as JsonValue) > LIMITS.checkpointBytes) {
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

/** Applies a process operator's exit to its plan node: success completes the node, failure applies the plan's recovery policy. */
function applyOperatorExit(workflow: Workflow, state: Execution, leaf: NodeFrame, event: ProcessExitEvent): EngineResult {
  const resolved = operatorScriptOf(workflow, state, leaf);
  if (!resolved) return fail(`frame ${leaf.key} is not a process operator node`);
  const { nodeId, operator, script: spec } = resolved;
  const failNode = (reason: string): EngineResult => {
    const checkpoint: Checkpoint = { summary: clipSummary(`Operator ${operator} node ${nodeId} ${reason}.`) };
    return applyNeedsWork(workflow, state, { checkpoint, issues: [{ target: nodeId, reason }] });
  };
  const output = processOutput(spec, event);
  if ("error" in output) return failNode(output.error);
  let checkpoint: Checkpoint = { summary: clipSummary(`Operator ${operator} exited ${event.exit.code} at node ${nodeId}.${output.truncation}`), data: output.value };
  if (event.store && canonicalJsonBytes(checkpoint as unknown as JsonValue) > LIMITS.nodeResultBytes) {
    const ref = event.store.publishJson("output", output.value);
    checkpoint = { summary: clipSummary(`Operator ${operator} exited ${event.exit.code} at node ${nodeId}; its ${ref.size}-byte output was published to the artifact store as ${ref.checksum}.${output.truncation}`), data: ref as unknown as JsonValue };
  }
  const execution = state.plans[planKeyOfNode(leaf)];
  if (!execution || execution.blockId !== leaf.blockId) return fail(`node frame ${leaf.key} has no plan execution`);
  const node = execution.plan.nodes.find((entry) => entry.id === nodeId);
  const contract = contractErrorFor(workflow, node && workflow.operators.get(node.operator)?.output, output.value, `node result ${nodeId}`);
  if (contract) return failNode(`violated its output contract: ${contract}`);
  try {
    validateCheckpoint(checkpoint, `node result ${leaf.key}`);
  } catch (error) {
    return failNode(`produced an invalid checkpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
  return completeNode(workflow, state, leaf, { status: "completed", met: [], checkpoint });
}

function exitFailureReason(spec: ScriptSpec, exit: ProcessExitEvent["exit"]): string {
  return exit.timedOut
    ? `timed out after ${spec.timeoutMs}ms`
    : exit.spawnError !== undefined
      ? `failed to start: ${exit.spawnError}`
      : exit.code === undefined
        ? `was terminated by signal ${exit.signal ?? "unknown"}`
        : `exited with code ${exit.code}, which is not in acceptedExitCodes [${spec.acceptedExitCodes.join(", ")}]`;
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
