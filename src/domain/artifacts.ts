import type { Execution } from "./execution.ts";
import { jsonPointerGet, type JsonValue } from "./json.ts";
import type { Workflow } from "./workflow.ts";
import { blockOf } from "./workflow.ts";
import { lastSegment } from "./keys.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type { InputBinding } from "./workflow.ts";
import type { ArtifactRef } from "./node.ts";

export type { ArtifactRef };

export type ResolvedInput =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: string };

export const ARTIFACT_MEDIA_TYPES = {
  json: "application/json",
  text: "text/plain; charset=utf-8",
  bytes: "application/octet-stream",
} as const;

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.invocationKey === "string"
    && typeof ref.output === "string"
    && typeof ref.checksum === "string"
    && typeof ref.size === "number"
    && typeof ref.mediaType === "string";
}

/** Publishes byte payloads into the run's artifact store and returns enriched references. */
export interface ArtifactSink {
  publishJson(name: string, value: JsonValue): ArtifactRef;
  publishText(name: string, text: string, mediaType?: string): ArtifactRef;
}

/** Publishes sinks under invocation keys; the run's artifact store is the canonical implementation. */
export interface ArtifactSinkProvider {
  sinkFor(invocationKey: string): ArtifactSink;
}

function selectValue(value: JsonValue, producerId: string, select: string | undefined): ResolvedInput {
  if (select === undefined) return { ok: true, value };
  const selected = jsonPointerGet(value, select);
  if (!selected.ok) return { ok: false, error: `input from "${producerId}"${select}: ${selected.error}` };
  return { ok: true, value: selected.value };
}

export function resolveBinding(workflow: Workflow, state: Execution, binding: InputBinding): ResolvedInput {
  if (binding.from === "$item") {
    const item = itemOf(state);
    if (item === undefined) return { ok: false, error: `input "from" names "$item", which resolves only inside a for_each loop body` };
    return selectValue(item, "$item", binding.select);
  }
  const block = blockOf(workflow, binding.from);
  if (!block) return { ok: false, error: `input "from" names "${binding.from}", which is not a step of ${workflow.name}` };
  if (block.kind === "task" || block.kind === "script") {
    const found = checkpointOf(workflow, state, block.id);
    if (!found) return { ok: false, error: `input "from" names "${block.id}", which has no recorded checkpoint yet` };
    return selectValue(found.checkpoint as unknown as JsonValue, block.id, binding.select);
  }
  if (block.kind === "plan") {
    const key = planKeyForBlock(state, block.id);
    if (key === undefined) {
      const skipped = checkpointOf(workflow, state, block.id);
      if (skipped?.checkpoint.skipped) return { ok: true, value: skipped.checkpoint as unknown as JsonValue };
      return { ok: false, error: `input "from" names "${block.id}", which has not produced a plan yet` };
    }
    const value = aggregateOf(state, key);
    if (value === undefined) return { ok: false, error: `input "from" names "${block.id}", which has no plan execution` };
    return selectValue(value, block.id, binding.select);
  }
  if (block.kind === "loop") {
    const found = checkpointOf(workflow, state, block.id);
    if (!found) return { ok: false, error: `input "from" names "${block.id}", which has not completed its loop yet` };
    return selectValue(found.checkpoint as unknown as JsonValue, block.id, binding.select);
  }
  return { ok: false, error: `input "from" names "${binding.from}", which does not produce artifacts` };
}

type ArtifactResult =
  | { readonly ok: true; readonly present: true; readonly value: JsonValue }
  | { readonly ok: true; readonly present: false; readonly skipped?: Checkpoint }
  | { readonly ok: false; readonly error: string };

function checkpointOf(workflow: Workflow, state: Execution, blockId: string): { key: string; checkpoint: NonNullable<Execution["checkpoints"][string]> } | undefined {
  const prefix = `${workflow.root.id}/`;
  const order = state.checkpointOrder ?? Object.keys(state.checkpoints);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const key = order[i];
    if (key.startsWith(prefix) && lastSegment(key) === blockId) {
      const checkpoint = state.checkpoints[key];
      if (checkpoint !== undefined) return { key, checkpoint };
    }
  }
  return undefined;
}

function aggregateOf(state: Execution, key: string): JsonValue | undefined {
  const execution = state.plans[key];
  if (!execution) return undefined;
  const currentIds = new Set(execution.plan.nodes.map((node) => node.id));
  const nodes = execution.plan.nodes.map((node) => ({
    id: node.id,
    operator: node.operator,
    objective: node.objective,
    ...(node.evidence !== undefined ? { evidence: [...node.evidence] } : {}),
    result: Object.hasOwn(execution.results, node.id)
      ? execution.results[node.id] as unknown as JsonValue
      : null,
  }));
  return { version: 1, nodes } as JsonValue;
}

export function planKeyForBlock(state: Execution, blockId: string): string | undefined {
  const entry = Object.entries(state.plans).find(([, execution]) => execution.blockId === blockId);
  return entry ? entry[0] : undefined;
}

function itemOf(state: Execution): JsonValue | undefined {
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    const frame = state.stack[i];
    if (frame.kind !== "loop") continue;
    const loopState = state.loops[frame.key];
    if (loopState?.items && loopState.items[loopState.iteration - 1] !== undefined) return loopState.items[loopState.iteration - 1];
  }
  return undefined;
}

export function producerArtifact(workflow: Workflow, state: Execution, blockId: string): ArtifactResult {
  const block = blockOf(workflow, blockId);
  if (!block) return { ok: false, error: `"${blockId}" is not a step of ${workflow.name}` };
  if (block.kind === "task" || block.kind === "script") {
    const found = checkpointOf(workflow, state, block.id);
    if (!found) return { ok: true, present: false };
    return { ok: true, present: true, value: found.checkpoint as unknown as JsonValue };
  }
  if (block.kind === "plan") {
    const key = planKeyForBlock(state, block.id);
    if (key === undefined) {
      const skipped = checkpointOf(workflow, state, block.id);
      if (skipped && skipped.checkpoint.skipped) return { ok: true, present: false, skipped: skipped.checkpoint };
      return { ok: true, present: false };
    }
    const value = aggregateOf(state, key);
    if (value === undefined) return { ok: true, present: false };
    return { ok: true, present: true, value };
  }
  if (block.kind === "loop") {
    const found = checkpointOf(workflow, state, block.id);
    if (!found) return { ok: true, present: false };
    return { ok: true, present: true, value: found.checkpoint as unknown as JsonValue };
  }
  return { ok: false, error: `"${blockId}" does not produce artifacts` };
}