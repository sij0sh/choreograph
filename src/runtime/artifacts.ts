import { ARTIFACT_MEDIA_TYPES, isArtifactRef, resolveBinding, type ResolvedInput } from "../domain/artifacts.ts";
import type { ArtifactRef } from "../domain/node.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { Execution } from "../domain/execution.ts";
import { isJsonValue, type JsonValue } from "../domain/json.ts";
import type { InputBinding, Workflow } from "../domain/workflow.ts";

export type { ResolvedInput } from "../domain/artifacts.ts";
export { resolveBinding };

export type ResolvedScriptInputs =
  | { readonly ok: true; readonly inputs: Readonly<Record<string, JsonValue>> }
  | { readonly ok: false; readonly error: string };

/** Loads an artifact reference back into the value it stores. */
export type RefValueLoader = (ref: ArtifactRef) => { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: string };

/**
 * Replaces every artifact reference in a resolved value with the value it stores, so
 * consumers of input bindings never see references - including values reached through $item.
 */
export function inlineRefs(value: JsonValue, load: RefValueLoader, depth = 0): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (depth > MATERIALIZE_DEPTH_MAX) return { ok: false, error: "nested input structure exceeds the artifact inlining depth bound" };
  if (isArtifactRef(value)) {
    const loaded = load(value);
    if (!loaded.ok) return { ok: false, error: `artifact ${value.checksum}: ${loaded.error}` };
    return loaded;
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const entry of value) {
      const done = inlineRefs(entry, load, depth + 1);
      if (!done.ok) return done;
      out.push(done.value);
    }
    return { ok: true, value: out };
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const done = inlineRefs(entry, load, depth + 1);
      if (!done.ok) return done;
      out[key] = done.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

/** A loader backed by the run's artifact store; JSON artifacts decode to values, text to strings. */
export function refLoaderFor(store: ArtifactStore): RefValueLoader {
  return (ref) => {
    const loaded = store.load(ref);
    if (!loaded.ok) return loaded;
    try {
      if (ref.mediaType === ARTIFACT_MEDIA_TYPES.json) {
        const parsed = JSON.parse(loaded.content.toString("utf8")) as unknown;
        if (!isJsonValue(parsed)) return { ok: false, error: `artifact ${ref.checksum} does not hold a JSON value` };
        return { ok: true, value: parsed };
      }
      return { ok: true, value: loaded.content.toString("utf8") };
    } catch (error) {
      return { ok: false, error: `artifact ${ref.checksum} could not be decoded: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

/** Materializes an artifact reference into the script's workspace and returns a workspace-relative path. */
export type ArtifactMaterializer = (ref: ArtifactRef) => { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };

const MATERIALIZE_DEPTH_MAX = 32;

function materializeRefs(value: JsonValue, materialize: ArtifactMaterializer, depth: number): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (depth > MATERIALIZE_DEPTH_MAX) return { ok: false, error: "nested input structure exceeds the artifact materialization depth bound" };
  if (isArtifactRef(value)) {
    const done = materialize(value);
    if (!done.ok) return { ok: false, error: `artifact ${value.checksum}: ${done.error}` };
    return { ok: true, value: done.path };
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const entry of value) {
      const done = materializeRefs(entry, materialize, depth + 1);
      if (!done.ok) return done;
      out.push(done.value);
    }
    return { ok: true, value: out };
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const done = materializeRefs(entry, materialize, depth + 1);
      if (!done.ok) return done;
      out[key] = done.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

/**
 * Resolve a script's declared inputs against the current execution.
 * Values arrive only through explicit bindings; there is no implicit
 * interpolation into argv or environment entries.
 */
export function resolveScriptInputs(workflow: Workflow, state: Execution, bindings: Readonly<Record<string, InputBinding>> | undefined, materialize?: ArtifactMaterializer): ResolvedScriptInputs {
  if (!bindings) return { ok: true, inputs: {} };
  const inputs: Record<string, JsonValue> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    const resolved = resolveBinding(workflow, state, binding);
    if (!resolved.ok) return { ok: false, error: `input "${name}": ${resolved.error}` };
    if (!materialize) {
      inputs[name] = resolved.value;
      continue;
    }
    const done = materializeRefs(resolved.value, materialize, 0);
    if (!done.ok) return { ok: false, error: `input "${name}": ${done.error}` };
    inputs[name] = done.value;
  }
  return { ok: true, inputs };
}
