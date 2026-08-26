import type { Execution } from "../domain/execution.ts";
import { jsonPointerGet, type JsonValue } from "../domain/json.ts";
import type { InputBinding, Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { lastSegment } from "../domain/keys.ts";

export type ResolvedInput =
  | { readonly ok: true; readonly value: JsonValue }
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

export function resolveBinding(workflow: Workflow, state: Execution, binding: InputBinding): ResolvedInput {
  const block = blockOf(workflow, binding.from);
  if (!block) return { ok: false, error: `input "from" names "${binding.from}", which is not a step of ${workflow.name}` };
  if (block.kind === "task") {
    const found = checkpointOf(workflow, state, block.id);
    if (!found) return { ok: false, error: `input "from" names "${block.id}", which has no recorded checkpoint yet` };
    const value = found.checkpoint as unknown as JsonValue;
    if (binding.select !== undefined) {
      const selected = jsonPointerGet(value, binding.select);
      if (!selected.ok) return { ok: false, error: `input from "${block.id}"${binding.select}: ${selected.error}` };
      return { ok: true, value: selected.value };
    }
    return { ok: true, value };
  }
  if (block.kind === "plan") {
    const planEntry = Object.entries(state.plans).find(([, execution]) => execution.blockId === block.id);
    const key = planEntry?.[0];
    if (key === undefined) {
      return { ok: false, error: `input "from" names "${block.id}", which has not produced a plan yet` };
    }
    const value = aggregateOf(state, key);
    if (value === undefined) return { ok: false, error: `input "from" names "${block.id}", which has no plan execution` };
    if (binding.select !== undefined) {
      const selected = jsonPointerGet(value, binding.select);
      if (!selected.ok) return { ok: false, error: `input from "${block.id}"${binding.select}: ${selected.error}` };
      return { ok: true, value: selected.value };
    }
    return { ok: true, value };
  }
  return { ok: false, error: `input "from" names "${binding.from}", which does not produce artifacts` };
}
