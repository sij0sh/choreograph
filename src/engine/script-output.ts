import { LIMITS } from "../domain/limits.ts";
import { isJsonValue, type JsonValue } from "../domain/json.ts";
import type { ArtifactRef, ArtifactSink } from "../domain/artifacts.ts";
import type { ScriptSpec } from "../domain/workflow.ts";

export interface ProcessExitEvent {
  readonly type: "process-exit";
  readonly key: string;
  readonly exit: { readonly code?: number; readonly signal?: string; readonly timedOut: boolean; readonly stdout: string; readonly stderr: string; readonly truncated: boolean; readonly spawnError?: string };
  readonly files?: readonly ArtifactRef[];
  readonly captureError?: string;
  readonly store: ArtifactSink;
}

const TEXT_STDOUT_BUDGET_BYTES = LIMITS.checkpointBytes - 256;

export function utf8Preview(value: string, max: number): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  let clipped = value;
  while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > max - 3) clipped = clipped.slice(0, Math.max(0, clipped.length - 16));
  return `${clipped}...`;
}

/** Adds side outputs (stderr, captured files) to the stdout-derived data without losing non-object stdout values. */
function mergeOutputSides(base: JsonValue, sides: Record<string, JsonValue>): JsonValue {
  if (Object.keys(sides).length === 0) return base;
  if (typeof base === "object" && base !== null && !Array.isArray(base)) return { ...base, ...sides };
  const wrapped: Record<string, JsonValue> = base === null ? {} : { stdout: base };
  return { ...wrapped, ...sides };
}

function capturedFilesSides(files: readonly ArtifactRef[] | undefined): Record<string, JsonValue> {
  if (!files || files.length === 0) return {};
  const refs: Record<string, JsonValue> = {};
  for (const ref of files) refs[ref.output] = ref as unknown as JsonValue;
  return { files: refs };
}

/** Applies the configured stderr mode: none keeps stderr diagnostic-only, text stores it, json parses it. */
function scriptStderrValue(spec: ScriptSpec, exit: ProcessExitEvent["exit"], store: ArtifactSink): { sides: Record<string, JsonValue>; clipped?: boolean } | { error: string } {
  if (spec.stderr === "none") return { sides: {} };
  if (spec.stderr === "text") {
    const text = exit.stderr;
    if (Buffer.byteLength(text, "utf8") <= TEXT_STDOUT_BUDGET_BYTES) return { sides: { stderr: text } };
    const ref = store.publishText("stderr", text);
    return { sides: { stderr: utf8Preview(text, 192), stderrArtifact: ref as unknown as JsonValue }, clipped: true };
  }
  try {
    const parsed = JSON.parse(exit.stderr) as unknown;
    if (!isJsonValue(parsed)) return { error: "stderr is not a JSON value" };
    return { sides: { stderr: parsed } };
  } catch (error) {
    return { error: `stderr is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function scriptStdoutValue(spec: ScriptSpec, exit: ProcessExitEvent["exit"], store: ArtifactSink): { value: JsonValue; clipped?: boolean } | { error: string } {
  let base: JsonValue = {};
  let stdoutClipped = false;
  if (spec.stdout === "json") {
    try {
      const parsed = JSON.parse(exit.stdout) as unknown;
      if (!isJsonValue(parsed)) return { error: "stdout is not a JSON value" };
      base = parsed;
    } catch (error) {
      return { error: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  } else if (spec.stdout === "text") {
    const stdout = exit.stdout;
    if (Buffer.byteLength(stdout, "utf8") <= TEXT_STDOUT_BUDGET_BYTES) {
      base = { stdout };
    } else {
      const ref = store.publishText("output", stdout);
      base = { stdout: utf8Preview(stdout, 192), stdoutTruncated: true, artifact: ref as unknown as JsonValue };
      stdoutClipped = true;
    }
  }
  const stderr = scriptStderrValue(spec, exit, store);
  if ("error" in stderr) return stderr;
  return { value: mergeOutputSides(base, stderr.sides), ...(stdoutClipped || stderr.clipped ? { clipped: true } : {}) };
}

export function processOutput(spec: ScriptSpec, event: ProcessExitEvent): { value: JsonValue; truncation: string } | { error: string } {
  if (event.captureError !== undefined) return { error: event.captureError };
  const accepted = !event.exit.timedOut && event.exit.code !== undefined && spec.acceptedExitCodes.includes(event.exit.code);
  if (!accepted) return { error: exitFailureReason(spec, event.exit) };
  const parsed = scriptStdoutValue(spec, event.exit, event.store);
  if ("error" in parsed) return parsed;
  return {
    value: mergeOutputSides(parsed.value, capturedFilesSides(event.files)),
    truncation: event.exit.truncated || parsed.clipped ? " (captured output was truncated)" : "",
  };
}

function exitFailureReason(spec: ScriptSpec, exit: ProcessExitEvent["exit"]): string {
  return exit.timedOut
    ? `timed out after ${spec.timeoutMs}ms`
    : exit.spawnError !== undefined
      ? `failed to start: ${exit.spawnError}`
      : exit.code === undefined
        ? `was terminated by signal ${exit.signal ?? "unknown"}`
        : `exited with code ${exit.code}, which is not in acceptedExitCodes [${spec.acceptedExitCodes.join(", ")}]`;
}
