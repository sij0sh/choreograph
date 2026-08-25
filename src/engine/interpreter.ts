import type { Checkpoint } from "../domain/checkpoint.ts";
import { validateCheckpoint } from "../domain/checkpoint.ts";
import type { Execution, Frame, NodeFrame, PlanExecution, SequenceFrame, TaskFrame } from "../domain/execution.ts";
import { resolveRecovery } from "../domain/policy.ts";
import { applyNeedsWork } from "./recovery.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import type { ChooseBlock, ForEachBlock, PlanBlock, RepeatBlock, SequenceBlock, TaskBlock, Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { resolveReference } from "../authoring/references.ts";
import { evaluatePredicate } from "../authoring/predicates.ts";
import { canonicalJson, type JsonValue } from "../domain/json.ts";
import { firstIncompleteNode } from "../planning/graph.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";
import { validateNodeResult, type NodeResult } from "../planning/schema.ts";

export interface Issue {
  readonly target: string;
  readonly reason: string;
}

export type TaskOutcome =
  | { readonly status: "completed"; readonly met?: readonly string[]; readonly checkpoint: Checkpoint }
  | { readonly status: "needs-work"; readonly checkpoint: Checkpoint; readonly issues?: readonly Issue[] }
  | { readonly status: "blocked"; readonly checkpoint: Checkpoint };

export type WorkflowEvent =
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

export interface StartInput {
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

function childKey(parentKey: string, childId: string): string {
  return `${parentKey}/${childId}`;
}

type PushResult = { leaf: boolean } | { error: string };

function caseNameOf(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "object") return canonicalJson(value);
  return String(value);
}

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
    case "foreach": {
      const items = resolveReference(view, child.items);
      if (items === undefined) return { leaf: false };
      if (!Array.isArray(items)) return { error: `${key} resolved $${child.items.root} to a non-list value` };
      if (items.length > LIMITS.forEachItems) return { error: `${key} iterates ${items.length} items; the bound is ${LIMITS.forEachItems}` };
      stack.push({ kind: "foreach", blockId: child.id, key, items, index: 0, variable: child.as });
      return { leaf: false };
    }
    case "repeat": {
      stack.push({ kind: "repeat", blockId: child.id, key, iteration: 0 });
      return { leaf: false };
    }
    case "choose": {
      const chosen = chooseBranch(view, child);
      if (!chosen) return { leaf: false };
      stack.push({ kind: "choose", blockId: child.id, key, caseName: chosen.name });
      stack.push({ kind: "sequence", blockId: chosen.body.id, key: childKey(`${key}:${chosen.name}`, chosen.body.id), index: 0 });
      return { leaf: false };
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

function chooseBranch(state: Execution, block: ChooseBlock): { name: string; body: SequenceBlock } | undefined {
  const value = resolveReference(state, block.value);
  const name = caseNameOf(value);
  if (name !== undefined && block.cases[name]) return { name, body: block.cases[name] };
  if (block.fallback) return { name: "fallback", body: block.fallback };
  return undefined;
}

type AdvanceResult = { ok: true; stack: readonly Frame[] } | { ok: false; error: string };

export function advance(workflow: Workflow, state: Execution): AdvanceResult {
  const stack = [...state.stack];
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
          if (parent?.kind === "foreach") {
            stack[stack.length - 1] = { ...parent, index: parent.index + 1 };
          } else if (parent?.kind === "repeat") {
            stack[stack.length - 1] = { ...parent, iteration: parent.iteration + 1 };
          }
          continue;
        }
        const advanced: SequenceFrame = { ...top, index: top.index + 1 };
        stack[topIndex] = advanced;
        const pushed = pushBlock(workflow, state, stack, advanced.key, child.id);
        if ("error" in pushed) return { ok: false, error: pushed.error };
        if (pushed.leaf) return { ok: true, stack };
        continue;
      }
      case "foreach": {
        const block = blockOf(workflow, top.blockId);
        if (!block || block.kind !== "foreach") return { ok: false, error: `frame ${top.key} does not name a for_each block` };
        if (top.index >= top.items.length) {
          stack.pop();
          continue;
        }
        const bodyKey = `${top.key}[${top.index}]`;
        stack.push({ kind: "sequence", blockId: block.body.id, key: childKey(bodyKey, block.body.id), index: 0 });
        continue;
      }
      case "repeat": {
        const block = blockOf(workflow, top.blockId);
        if (!block || block.kind !== "repeat") return { ok: false, error: `frame ${top.key} does not name a repeat block` };
        const view: Execution = { ...state, stack };
        if (top.iteration >= block.max) {
          stack.pop();
          continue;
        }
        if (top.iteration > 0 && block.until && evaluatePredicate(view, block.until)) {
          stack.pop();
          continue;
        }
        const bodyKey = `${top.key}#${top.iteration}`;
        stack.push({ kind: "sequence", blockId: block.body.id, key: childKey(bodyKey, block.body.id), index: 0 });
        continue;
      }
      case "choose":
        stack.pop();
        continue;
      case "plan": {
        if (top.mode === "create") return { ok: true, stack };
        const execution = state.plans[top.key];
        if (!execution || execution.blockId !== top.blockId) return { ok: false, error: `plan frame ${top.key} has no execution` };
        const node = firstIncompleteNode(execution);
        if (!node) {
          stack.pop();
          continue;
        }
        stack.push({ kind: "node", blockId: top.blockId, key: `${top.key}/${node.id}`, nodeId: node.id, attempt: 1 });
        return { ok: true, stack };
      }
      case "task":
      case "node":
        return { ok: true, stack };
      default:
        return { ok: false, error: `frame kind "${(top as Frame).kind}" is not supported yet` };
    }
  }
  return { ok: true, stack };
}

function checkCriteria(criteria: readonly string[], met: readonly string[]): string | undefined {
  const known = new Set(criteria);
  for (const id of met) {
    if (!known.has(id)) return `unknown criterion id: ${id}`;
  }
  const metSet = new Set(met);
  if (metSet.size !== met.length) return "met must not contain duplicates";
  for (const id of criteria) {
    if (!metSet.has(id)) return `completion must list every required criterion; missing: ${id}`;
  }
  return undefined;
}

function validateOutcome(outcome: TaskOutcome): string | undefined {
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
    validateCheckpoint(outcome.checkpoint, "checkpoint");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function commitCheckpoint(state: Execution, key: string, checkpoint: Checkpoint): Execution["checkpoints"] {
  return { ...state.checkpoints, [key]: checkpoint };
}

function needsWork(workflow: Workflow, state: Execution, outcome: Extract<TaskOutcome, { status: "needs-work" }>): EngineResult {
  return applyNeedsWork(workflow, state, outcome);
}

function planKeyOfNode(node: NodeFrame): string {
  return node.key.slice(0, node.key.lastIndexOf("/"));
}

function finishAdvance(workflow: Workflow, state: Execution, stack: readonly Frame[]): EngineResult {
  const advanced = advance(workflow, { ...state, stack });
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.stack.length === 0) {
    return { ok: true, state: { ...state, stack: [], status: "completed" }, effect: { kind: "complete" } };
  }
  return { ok: true, state: { ...state, stack: advanced.stack }, effect: { kind: "deliver" } };
}

function completePlanCreation(workflow: Workflow, state: Execution, leaf: Extract<Frame, { kind: "plan" }>, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const block = blockOf(workflow, leaf.blockId);
  if (!block || block.kind !== "plan") return fail(`frame ${leaf.key} does not name a plan block`);
  const planValue = (outcome.checkpoint.data as { plan?: unknown } | undefined)?.plan;
  if (planValue === undefined) return fail("plan creation completion must carry checkpoint.data.plan");
  const previous = state.plans[leaf.key];
  const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators, new Set(Object.keys(previous?.results ?? {}))));
  if ("errors" in validation) return fail(`invalid plan: ${validation.errors.join("; ")}`);
  const execution: PlanExecution = {
    blockId: block.id,
    revision: previous ? previous.revision : 1,
    replans: previous ? previous.replans : 0,
    invalidations: previous ? previous.invalidations : 0,
    plan: validation.plan,
    results: previous ? previous.results : {},
  };  const plans = { ...state.plans, [leaf.key]: execution };
  const stack: Frame[] = [...state.stack.slice(0, -1), { kind: "plan", blockId: block.id, key: leaf.key, mode: "execute" as const, attempt: 1 }];
  return finishAdvance(workflow, { ...state, plans }, stack);
}

function completeNode(workflow: Workflow, state: Execution, leaf: NodeFrame, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const planKey = planKeyOfNode(leaf);
  const execution = state.plans[planKey];
  if (!execution || execution.blockId !== leaf.blockId) return fail(`node frame ${leaf.key} has no plan execution`);
  const node = execution.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  if (!node) return fail(`node ${leaf.nodeId} is not in the active plan`);
  const criteriaError = checkCriteria(node.done, outcome.met ?? []);
  if (criteriaError) return fail(criteriaError);
  const { checkpoint } = outcome;
  let result: NodeResult;
  try {
    result = validateNodeResult(
      {
        id: node.id,
        summary: checkpoint.summary,
        ...(checkpoint.evidence ? { evidence: checkpoint.evidence } : {}),
        ...(checkpoint.decisions ? { decisions: checkpoint.decisions } : {}),
        ...(checkpoint.unknowns ? { unknowns: checkpoint.unknowns } : {}),
        ...(checkpoint.data !== undefined ? { data: checkpoint.data } : {}),
      },
      `node result ${node.id}`,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const plans = { ...state.plans, [planKey]: { ...execution, results: { ...execution.results, [node.id]: result } } };
  return finishAdvance(workflow, { ...state, plans }, state.stack.slice(0, -1));
}

export function start(workflow: Workflow, input: StartInput): EngineResult {
  if (workflow.root.children.length === 0) return fail("workflow has no steps");
  const base: Execution = {
    workflowName: workflow.name,
    runId: input.runId,
    target: input.target ?? "",
    status: "active",
    stack: [],
    checkpoints: {},
    plans: {},
  };
  const entered: Execution = { ...base, stack: [{ kind: "sequence", blockId: workflow.root.id, key: workflow.root.id, index: 0 }] };
  const advanced = advance(workflow, entered);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.stack.length === 0) return fail("workflow has no runnable steps");
  return { ok: true, state: { ...entered, stack: advanced.stack }, effect: { kind: "deliver" } };
}

export function transition(workflow: Workflow, state: Execution, event: WorkflowEvent): EngineResult {
  if (state.status !== "active") return fail("execution is not active");
  if (event.type === "abort") {
    return { ok: true, state: { ...state, status: "aborted" }, effect: { kind: "aborted" } };
  }
  const outcome = event.outcome;
  const invalid = validateOutcome(outcome);
  if (invalid) return fail(invalid);
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || !isLeafFrame(leaf)) return fail("execution has no current leaf task");
  switch (outcome.status) {
    case "blocked": {
      return { ok: true, state: { ...state, checkpoints: commitCheckpoint(state, leaf.key, outcome.checkpoint) }, effect: { kind: "stay" } };
    }
    case "needs-work":
      return needsWork(workflow, state, outcome);
    case "completed": {
      if (leaf.kind === "plan") return completePlanCreation(workflow, state, leaf, outcome);
      if (leaf.kind === "node") return completeNode(workflow, state, leaf, outcome);
      if (leaf.kind !== "task") return fail("completion for this position is not supported");
      const block = blockOf(workflow, leaf.blockId);
      if (!block || block.kind !== "task") return fail(`frame ${leaf.key} does not name a task`);
      const criteriaError = checkCriteria(block.done ?? [], outcome.met ?? []);
      if (criteriaError) return fail(criteriaError);
      const checkpoints = commitCheckpoint(state, leaf.key, outcome.checkpoint);
      const popped: Execution = { ...state, stack: state.stack.slice(0, -1), checkpoints };
      return finishAdvance(workflow, popped, popped.stack);
    }
  }
}

export interface PositionInfo {
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
      return { type: "plan-create", key: leaf.key, attempt: 1, plan: block, execution: state.plans[leaf.key], stack: state.stack };
    }
    return undefined;
  }
  if (leaf.kind === "node") {
    const block = blockOf(workflow, leaf.blockId);
    const planKey = leaf.key.slice(0, leaf.key.lastIndexOf("/"));
    const execution = state.plans[planKey];
    const node = execution?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
    if (block?.kind === "plan" && execution && node) {
      return { type: "node", key: leaf.key, attempt: leaf.attempt, plan: block, node, execution, stack: state.stack };
    }
    return undefined;
  }
  return undefined;
}
