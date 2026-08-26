import type { Execution } from "../domain/execution.ts";
import { jsonPointerGet, type JsonValue } from "../domain/json.ts";
import type { InputBinding, Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { aggregateOf, checkpointOf, planKeyForBlock } from "../domain/artifacts.ts";

export type ResolvedInput =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: string };

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
    const key = planKeyForBlock(state, block.id);
    if (key === undefined) {
      const skipped = checkpointOf(workflow, state, block.id);
      if (skipped?.checkpoint.skipped) return { ok: true, value: skipped.checkpoint as unknown as JsonValue };
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
