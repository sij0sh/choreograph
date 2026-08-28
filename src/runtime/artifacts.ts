import { resolveBinding, type ResolvedInput } from "../domain/artifacts.ts";
import type { Execution } from "../domain/execution.ts";
import type { JsonValue } from "../domain/json.ts";
import type { InputBinding, Workflow } from "../domain/workflow.ts";

export type { ResolvedInput } from "../domain/artifacts.ts";
export { resolveBinding };

export type ResolvedScriptInputs =
  | { readonly ok: true; readonly inputs: Readonly<Record<string, JsonValue>> }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a script's declared inputs against the current execution.
 * Values arrive only through explicit bindings; there is no implicit
 * interpolation into argv or environment entries.
 */
export function resolveScriptInputs(workflow: Workflow, state: Execution, bindings: Readonly<Record<string, InputBinding>> | undefined): ResolvedScriptInputs {
  if (!bindings) return { ok: true, inputs: {} };
  const inputs: Record<string, JsonValue> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    const resolved = resolveBinding(workflow, state, binding);
    if (!resolved.ok) return { ok: false, error: `input "${name}": ${resolved.error}` };
    inputs[name] = resolved.value;
  }
  return { ok: true, inputs };
}
