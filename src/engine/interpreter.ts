import type { Checkpoint } from "../domain/checkpoint.ts";
import { checkpointErrors, validateCheckpoint } from "../domain/checkpoint.ts";
import {
  frameAttempt,
  isAttemptBearingFrame,
  isLeafFrame,
  upsertInvocation,
  type Run,
  type Frame,
  type PlanNodeFrame,
  type PlanRecord,
  type SequenceFrame,
  type TaskFrame,
} from "../domain/run.ts";
import { applyNeedsWork } from "./recovery.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import { LIMITS } from "../domain/limits.ts";
import { scopeKey } from "../domain/keys.ts";
import { noteCheckpointRemoved, notePlanKeyCreated } from "../domain/checkpoint-index.ts";
import { evaluateGuard } from "../domain/guard.ts";
import type { OperatorDescriptor, ScriptBlock, ScriptSpec, Workflow } from "../domain/workflow.ts";
import { blockOf, isGuardBearingBlock } from "../domain/workflow.ts";
import { type Invocation, type InvocationStatus, type RunnerKind } from "../domain/invocation.ts";
import { type ArtifactSinkProvider } from "../domain/artifacts.ts";
import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { firstIncompleteNode } from "../planning/graph.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";
import { processOutput, type ProcessExitEvent } from "./script-output.ts";
import { blockedProblems, checkCriteria, completedProblems, joined, outcomeShapeErrors, planKeyOfNode, type Issue, type TaskOutcome } from "./outcome.ts";
import { clipSummary, finishLoop, loopAt, pushBlock, sequenceAt, skipBlock, withCheckpoint } from "./progress.ts";

export type { Issue, TaskOutcome } from "./outcome.ts";

type WorkflowEvent =
  | { readonly type: "outcome"; readonly outcome: TaskOutcome }
  | ProcessExitEvent;

export type Effect =
  | { readonly kind: "deliver" }
  | { readonly kind: "stay" }
  | { readonly kind: "complete" }
  | { readonly kind: "run-process"; readonly key: string };

export type EngineResult =
  | { readonly ok: true; readonly state: Run; readonly effect: Effect }
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

function scriptLeafAt(workflow: Workflow, state: Run): { key: string; block: ScriptBlock } | undefined {
  if (state.status !== "active") return undefined;
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || leaf.kind !== "task") return undefined;
  const block = blockOf(workflow, leaf.blockId);
  return block?.kind === "script" ? { key: leaf.key, block } : undefined;
}

type AdvanceResult = { ok: true; state: Run } | { ok: false; error: string };

export function advance(workflow: Workflow, state: Run, store?: ArtifactSinkProvider): AdvanceResult {
  const stack = [...state.stack];
  let working: Run = state;
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
          const view: Run = { ...working, stack };
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
        const record = state.plans[top.key];
        if (!record || record.blockId !== top.blockId) return { ok: false, error: `plan frame ${top.key} has no execution` };
        const node = firstIncompleteNode(record);
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

function finishAdvance(workflow: Workflow, state: Run, stack: readonly Frame[], store?: ArtifactSinkProvider): EngineResult {
  const advanced = advance(workflow, { ...state, stack }, store);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) {
    return { ok: true, state: { ...advanced.state, stack: [], status: "completed" }, effect: { kind: "complete" } };
  }
  return leafEffect(workflow, advanced.state, { kind: "deliver" });
}

/** The script leaf at the top of the stack, when the runtime itself must execute it. */
export function processLeafAt(workflow: Workflow, state: Run): ProcessLeaf | undefined {
  const staticLeaf = scriptLeafAt(workflow, state);
  if (!staticLeaf) return undefined;
  return { key: staticLeaf.key, blockId: staticLeaf.block.id, script: staticLeaf.block.script, ...(staticLeaf.block.inputs ? { inputs: staticLeaf.block.inputs } : {}) };
}

function runnerOfLeaf(workflow: Workflow, state: Run, leaf: Frame): RunnerKind {
  if (leaf.kind === "task") return blockOf(workflow, leaf.blockId)?.kind === "script" ? "process" : "agent";
  return "agent";
}
export function enterInvocation(workflow: Workflow, state: Run, leaf: Frame, status: InvocationStatus = "running", attempt?: number): Run {
  const invocation: Invocation = {
    blockId: leaf.blockId,
    key: leaf.key,
    runner: runnerOfLeaf(workflow, state, leaf),
    status,
    attempt: attempt ?? frameAttempt(leaf),
  };
  const invocations = upsertInvocation(state, leaf.key, invocation);
  return invocations === state.invocations ? state : { ...state, invocations };
}

function leafEffect(workflow: Workflow, state: Run, fallback: Effect): EngineResult {
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

function completePlanCreation(workflow: Workflow, state: Run, leaf: Extract<Frame, { kind: "plan" }>, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const block = blockOf(workflow, leaf.blockId);
  if (!block || block.kind !== "plan") return fail(`frame ${leaf.key} does not name a plan block`);
  const planValue = (outcome.checkpoint.data as { plan?: unknown } | undefined)?.plan;
  if (planValue === undefined) return fail("plan creation completion must carry checkpoint.data.plan");
  const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators));
  if ("errors" in validation) return fail(`invalid plan: ${validation.errors.join("; ")}`);
  const record: PlanRecord = {
    blockId: block.id,
    plan: validation.plan,
    results: {},
  };
  const planKeyed = withCheckpoint(state, leaf.key, stripPlanPayload(outcome.checkpoint));
  notePlanKeyCreated(planKeyed, block.id, leaf.key);
  const plans = { ...planKeyed.plans, [leaf.key]: record };
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

function completeNode(workflow: Workflow, state: Run, leaf: PlanNodeFrame, outcome: Extract<TaskOutcome, { status: "completed" }>): EngineResult {
  const planKey = planKeyOfNode(leaf);
  const record = state.plans[planKey];
  if (!record || record.blockId !== leaf.blockId) return fail(`node frame ${leaf.key} has no plan execution`);
  const node = record.plan.nodes.find((entry) => entry.id === leaf.nodeId);
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
      ...record,
      results: { ...record.results, [node.id]: result },
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
  const base: Run = {
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
  const entered: Run = { ...base, stack: [{ kind: "sequence", blockId: workflow.root.id, key: workflow.root.id, index: 0 }] };
  const advanced = advance(workflow, entered, store);
  if (!advanced.ok) return fail(advanced.error);
  if (advanced.state.stack.length === 0) return fail("workflow has no runnable steps");
  return leafEffect(workflow, advanced.state, { kind: "deliver" });
}

export function transition(workflow: Workflow, state: Run, event: WorkflowEvent, store?: ArtifactSinkProvider): EngineResult {
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
      const popped: Run = { ...committed, stack: state.stack.slice(0, -1) };
      return finishAdvance(workflow, popped, popped.stack, store);
    }
  }
}

function applyProcessExit(workflow: Workflow, state: Run, event: ProcessExitEvent, store?: ArtifactSinkProvider): EngineResult {
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
  const popped: Run = { ...succeeded, stack: state.stack.slice(0, -1) };
  return finishAdvance(workflow, popped, popped.stack, store);
}

function scriptFailure(workflow: Workflow, state: Run, leaf: Extract<Frame, TaskFrame>, block: ScriptBlock, reason: string): EngineResult {
  const checkpoint: Checkpoint = { summary: clipSummary(`Script ${block.id} ${reason}.`) };
  const result = applyNeedsWork(workflow, state, { checkpoint, issues: [{ target: block.id, reason }] });
  if (!result.ok || result.effect.kind !== "stay") return result;
  return { ...result, state: enterInvocation(workflow, result.state, leaf, "waiting") };
}

