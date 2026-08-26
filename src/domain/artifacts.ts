import type { Execution } from "./execution.ts";
import { jsonPointerGet, type JsonValue } from "./json.ts";
import type { Workflow } from "./workflow.ts";
import { blockOf } from "./workflow.ts";
import { lastSegment } from "./keys.ts";
import type { Checkpoint } from "./checkpoint.ts";

export type ArtifactResult =
  | { readonly ok: true; readonly present: true; readonly value: JsonValue }
  | { readonly ok: true; readonly present: false; readonly skipped?: Checkpoint }
  | { readonly ok: false; readonly error: string };

export function checkpointOf(workflow: Workflow, state: Execution, blockId: string): { key: string; checkpoint: NonNullable<Execution["checkpoints"][string]> } | undefined {
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

export function aggregateOf(state: Execution, key: string): JsonValue | undefined {
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
  for (const id of Object.keys(execution.results).filter((resultId) => !currentIds.has(resultId)).sort()) {
    nodes.push({
      id,
      operator: execution.resultOperators?.[id] ?? "unknown",
      objective: "Retained artifact from an earlier plan revision.",
      result: execution.results[id] as unknown as JsonValue,
    });
  }
  return { version: 1, revision: execution.revision, nodes } as JsonValue;
}

export function planKeyForBlock(state: Execution, blockId: string): string | undefined {
  const entry = Object.entries(state.plans).find(([, execution]) => execution.blockId === blockId);
  return entry ? entry[0] : undefined;
}

export function producerArtifact(workflow: Workflow, state: Execution, blockId: string): ArtifactResult {
  const block = blockOf(workflow, blockId);
  if (!block) return { ok: false, error: `"${blockId}" is not a step of ${workflow.name}` };
  if (block.kind === "task") {
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
  return { ok: false, error: `"${blockId}" does not produce artifacts` };
}

export function selectFrom(artifact: Extract<ArtifactResult, { ok: true; present: true }>, select: string | undefined): ArtifactResult {
  if (select === undefined) return artifact;
  const selected = jsonPointerGet(artifact.value, select);
  if (!selected.ok) return { ok: true, present: false };
  return { ok: true, present: true, value: selected.value };
}
