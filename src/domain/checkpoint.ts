import { canonicalJsonBytes, isJsonValue, jsonDepth, objectAt, requireString, type JsonValue } from "./json.ts";
import { LIMITS } from "./limits.ts";

export interface Checkpoint {
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly decisions?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly data?: JsonValue;
  readonly skipped?: boolean;
}

function boundedStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  if (value.length > LIMITS.checkpointListItems) throw new Error(`${label} must have at most ${LIMITS.checkpointListItems} items`);
  return value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`);
    if (Buffer.byteLength(text, "utf8") > LIMITS.checkpointItemBytes) throw new Error(`${label}[${index}] exceeds ${LIMITS.checkpointItemBytes} bytes`);
    return text;
  });
}

function dataAt(value: unknown, label: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) throw new Error(`${label} must be a JSON value`);
  if (jsonDepth(value) > LIMITS.jsonDepth) throw new Error(`${label} nesting must not exceed ${LIMITS.jsonDepth} levels`);
  return value as JsonValue;
}

export function validateCheckpoint(value: unknown, label: string, exemptsPlan = false): Checkpoint {
  const raw = objectAt(value, label);
  for (const key of Object.keys(raw)) {
    if (! ["summary", "evidence", "decisions", "unknowns", "data", "skipped"].includes(key)) throw new Error(`${label}.${key} is not an accepted checkpoint field`);
  }
  if (raw.skipped !== undefined && raw.skipped !== true) throw new Error(`${label}.skipped must be true when present`);
  const summary = requireString(raw.summary, `${label}.summary`);
  if (Buffer.byteLength(summary, "utf8") > LIMITS.checkpointSummaryBytes) throw new Error(`${label}.summary exceeds ${LIMITS.checkpointSummaryBytes} bytes`);
  const checkpoint: { summary: string; evidence?: string[]; decisions?: string[]; unknowns?: string[]; data?: JsonValue; skipped?: boolean } = { summary };
  const evidence = boundedStringList(raw.evidence, `${label}.evidence`);
  const decisions = boundedStringList(raw.decisions, `${label}.decisions`);
  const unknowns = boundedStringList(raw.unknowns, `${label}.unknowns`);
  const data = dataAt(raw.data, `${label}.data`);
  if (evidence) checkpoint.evidence = evidence;
  if (decisions) checkpoint.decisions = decisions;
  if (unknowns) checkpoint.unknowns = unknowns;
  if (data !== undefined) checkpoint.data = data;
  if (raw.skipped === true) checkpoint.skipped = true;
  const measured = exemptsPlan && data !== undefined && (data as { plan?: unknown })?.plan !== undefined
    ? (Object.keys(data as object).length === 1
      ? { summary: checkpoint.summary } as typeof checkpoint
      : (() => {
          const rest: Record<string, unknown> = { ...(data as Record<string, unknown>) };
          delete rest.plan;
          return { ...checkpoint, data: rest as import("./json.ts").JsonValue };
        })())
    : checkpoint;
  if (canonicalJsonBytes(measured as unknown as JsonValue) > LIMITS.checkpointBytes) throw new Error(`${label} exceeds ${LIMITS.checkpointBytes} bytes`);
  return checkpoint;
}
