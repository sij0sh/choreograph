import type { Run, PlanRecord } from "./run.ts";
import { jsonPointerGet, type JsonValue } from "./json.ts";
import type { Workflow } from "./workflow.ts";
import { blockOf, isBindableBlock, type AuthoredBlock } from "./workflow.ts";
import type { PlanNode } from "../planning/schema.ts";
import { checkpointIndexFor } from "./checkpoint-index.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type { InputBinding } from "./workflow.ts";
import type { ArtifactRef } from "./invocation.ts";

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

export function resolveBinding(workflow: Workflow, state: Run, binding: InputBinding): ResolvedInput {
  if (binding.from === "$item") {
    const item = itemOf(state);
    if (item === undefined) return { ok: false, error: `input "from" names "$item", which resolves only inside a for_each loop body` };
    return selectValue(item, "$item", binding.select);
  }
  const block = blockOf(workflow, binding.from);
  if (!block) return { ok: false, error: `input "from" names "${binding.from}", which is not a step of ${workflow.name}` };
  if (!isBindableBlock(block)) return { ok: false, error: `input "from" names "${binding.from}", which does not produce artifacts` };
  const artifact = artifactForBlock(workflow, state, block);
  if (!artifact.ok) return { ok: false, error: `input "from" names "${binding.from}", which does not produce artifacts` };
  if (artifact.present) return selectValue(artifact.value, block.id, binding.select);
  if (artifact.skipped) return selectValue(artifact.skipped as unknown as JsonValue, block.id, binding.select);
  switch (artifact.reason) {
    case "checkpoint":
      return { ok: false, error: `input "from" names "${block.id}", which has no recorded checkpoint yet` };
    case "plan":
      return { ok: false, error: `input "from" names "${block.id}", which has not produced a plan yet` };
    case "plan-execution":
      return { ok: false, error: `input "from" names "${block.id}", which has no plan execution` };
    case "loop":
      return { ok: false, error: `input "from" names "${block.id}", which has not completed its loop yet` };
    default: {
      const exhaustive: never = artifact.reason;
      return exhaustive;
    }
  }
}

type ArtifactAbsence = "checkpoint" | "plan" | "plan-execution" | "loop";

export type ArtifactResult =
  | { readonly ok: true; readonly present: true; readonly value: JsonValue }
  | { readonly ok: true; readonly present: false; readonly reason: ArtifactAbsence; readonly skipped?: Checkpoint }
  | { readonly ok: false; readonly error: string };

function checkpointOf(workflow: Workflow, state: Run, blockId: string): { key: string; checkpoint: NonNullable<Run["checkpoints"][string]> } | undefined {
  return checkpointIndexFor(state, `${workflow.root.id}/`).newestByBlock.get(blockId);
}

export function completedPlanNodeOf(
  record: PlanRecord,
  nodeId: string,
): { readonly node: PlanNode; readonly result: Checkpoint } | undefined {
  const node = record.plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !Object.hasOwn(record.results, nodeId)) return undefined;
  const result = record.results[nodeId];
  return result === undefined ? undefined : { node, result };
}

function aggregateOf(state: Run, key: string): JsonValue | undefined {
  const record = state.plans[key];
  if (!record) return undefined;
  const nodes = record.plan.nodes.map((node) => ({
    id: node.id,
    operator: node.operator,
    objective: node.objective,
    ...(node.evidence !== undefined ? { evidence: [...node.evidence] } : {}),
    result: (completedPlanNodeOf(record, node.id)?.result ?? null) as unknown as JsonValue,
  }));
  return { version: 1, nodes } as JsonValue;
}

function planKeyForBlock(workflow: Workflow, state: Run, blockId: string): string | undefined {
  return checkpointIndexFor(state, `${workflow.root.id}/`).planKeyByBlock.get(blockId);
}

function itemOf(state: Run): JsonValue | undefined {
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    const frame = state.stack[i];
    if (frame.kind !== "loop") continue;
    const loopState = state.loops[frame.key];
    if (loopState?.items && loopState.items[loopState.iteration - 1] !== undefined) return loopState.items[loopState.iteration - 1];
  }
  return undefined;
}

function artifactForBlock(workflow: Workflow, state: Run, block: AuthoredBlock): ArtifactResult {
  switch (block.kind) {
    case "task":
    case "script": {
      const found = checkpointOf(workflow, state, block.id);
      return found
        ? { ok: true, present: true, value: found.checkpoint as unknown as JsonValue }
        : { ok: true, present: false, reason: "checkpoint" };
    }
    case "plan": {
      const key = planKeyForBlock(workflow, state, block.id);
      if (key === undefined) {
        const skipped = checkpointOf(workflow, state, block.id)?.checkpoint;
        return skipped?.skipped
          ? { ok: true, present: false, reason: "plan", skipped }
          : { ok: true, present: false, reason: "plan" };
      }
      const value = aggregateOf(state, key);
      return value === undefined
        ? { ok: true, present: false, reason: "plan-execution" }
        : { ok: true, present: true, value };
    }
    case "loop": {
      const found = checkpointOf(workflow, state, block.id);
      return found
        ? { ok: true, present: true, value: found.checkpoint as unknown as JsonValue }
        : { ok: true, present: false, reason: "loop" };
    }
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

export function producerArtifact(workflow: Workflow, state: Run, blockId: string): ArtifactResult {
  const block = blockOf(workflow, blockId);
  if (!block) return { ok: false, error: `"${blockId}" is not a step of ${workflow.name}` };
  if (!isBindableBlock(block)) return { ok: false, error: `"${blockId}" does not produce artifacts` };
  return artifactForBlock(workflow, state, block);
}