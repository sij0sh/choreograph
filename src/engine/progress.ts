import type { Checkpoint } from "../domain/checkpoint.ts";
import { checkpointErrors } from "../domain/checkpoint.ts";
import { noteCheckpointCommitted, notePlanKeyRemoved } from "../domain/checkpoint-index.ts";
import { evaluateGuard, skipReason, type GuardClause } from "../domain/guard.ts";
import { lastSegment, scopeKey } from "../domain/keys.ts";
import { LIMITS } from "../domain/limits.ts";
import type { JsonValue } from "../domain/json.ts";
import type { Run, Frame, LoopState, SequenceFrame } from "../domain/run.ts";
import { blockOf, type LoopBlock, type SequenceBlock, type Workflow } from "../domain/workflow.ts";
import { isArtifactRef, resolveBinding, type ArtifactSinkProvider } from "../domain/artifacts.ts";
import { utf8Preview } from "./script-output.ts";
import { firstIncompleteNode } from "../planning/graph.ts";
import { joined } from "./outcome.ts";

export function sequenceAt(workflow: Workflow, frame: SequenceFrame): SequenceBlock | undefined {
  const block = blockOf(workflow, frame.blockId);
  return block?.kind === "sequence" ? block : undefined;
}

export function loopAt(workflow: Workflow, blockId: string): LoopBlock | undefined {
  const block = blockOf(workflow, blockId);
  return block?.kind === "loop" ? block : undefined;
}

export function childKey(parentKey: string, childId: string): string {
  return `${parentKey}/${childId}`;
}

type PushResult = { leaf: boolean; loops?: Record<string, LoopState> } | { error: string };

export function pushBlock(workflow: Workflow, state: Run, stack: Frame[], parentKey: string, childId: string): PushResult {
  const child = blockOf(workflow, childId);
  if (!child) return { error: `unknown block id: ${childId}` };
  const key = childKey(parentKey, child.id);
  const view: Run = { ...state, stack };
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

export function clipSummary(value: string): string {
  return utf8Preview(value, LIMITS.checkpointSummaryBytes - 64);
}

export function skipBlock(state: Run, parentKey: string, guard: GuardClause, blockId: string, isPlan: boolean): Run {
  const key = childKey(parentKey, blockId);
  const withCp = withCheckpoint(state, key, { summary: clipSummary(skipReason(guard)), skipped: true });
  if (!isPlan) return withCp;
  const plans = { ...withCp.plans };
  for (const [planKey, record] of Object.entries(plans)) {
    if (record.blockId === blockId) {
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
export function finishLoop(state: Run, loopKey: string, block: LoopBlock, store: ArtifactSinkProvider): { state: Run } | { error: string } {
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

export function withCheckpoint(state: Run, key: string, checkpoint: Checkpoint): Run {
  // Copy-on-write (corr-d1): refusal branches in the runtime must find the
  // input execution untouched, so a refused transition changes nothing.
  const tracked = Object.hasOwn(state.checkpoints, key);
  const next: Run = {
    ...state,
    checkpoints: { ...state.checkpoints, [key]: checkpoint },
    checkpointOrder: tracked ? state.checkpointOrder : [...state.checkpointOrder, key],
  };
  noteCheckpointCommitted(next, key, checkpoint);
  return next;
}
