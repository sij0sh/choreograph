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

export const TRANSITION_SHAPE = {
  statuses: ["completed", "needs-work", "blocked"],
  fields: {
    status: { required: true },
    key: { required: true },
    met: { required: false, onlyWith: "completed" },
    checkpoint: { required: true },
    issues: { required: false, onlyWith: "needs-work" },
  },
  checkpointFields: {
    summary: { required: true, boundary: "accept" },
    evidence: { required: false, boundary: "accept" },
    decisions: { required: false, boundary: "accept" },
    unknowns: { required: false, boundary: "accept" },
    data: { required: false, boundary: "accept" },
    // Engine-generated checkpoints may carry skipped. The model-facing boundary rejects it.
    skipped: { required: false, boundary: "reject" },
  },
} as const satisfies {
  readonly statuses: readonly string[];
  readonly fields: Record<"status" | "key" | "met" | "checkpoint" | "issues", { readonly required: boolean; readonly onlyWith?: string }>;
  readonly checkpointFields: Record<keyof Checkpoint, { readonly required: boolean; readonly boundary: "accept" | "reject" }>;
};

export type TransitionStatus = (typeof TRANSITION_SHAPE.statuses)[number];
export type TransitionField = keyof typeof TRANSITION_SHAPE.fields;
export type CheckpointField = keyof typeof TRANSITION_SHAPE.checkpointFields;
export type BoundaryCheckpointField = {
  [K in CheckpointField]: (typeof TRANSITION_SHAPE.checkpointFields)[K]["boundary"] extends "accept" ? K : never;
}[CheckpointField];

export const TRANSITION_FIELDS = Object.keys(TRANSITION_SHAPE.fields) as TransitionField[];
export const CHECKPOINT_KEYS = Object.keys(TRANSITION_SHAPE.checkpointFields) as CheckpointField[];
export const BOUNDARY_CHECKPOINT_FIELDS = CHECKPOINT_KEYS.filter(
  (field): field is BoundaryCheckpointField => TRANSITION_SHAPE.checkpointFields[field].boundary === "accept",
);

type MutableCheckpoint = { -readonly [K in keyof Checkpoint]: Checkpoint[K] };

interface Bounded {
  value?: string[];
  valid: boolean;
}

function boundedStringList(value: unknown, label: string, errors: string[]): Bounded {
  if (value === undefined) return { valid: true };
  if (!Array.isArray(value)) {
    errors.push(`${label} must be a list`);
    return { valid: false };
  }
  const out: string[] = [];
  let valid = true;
  if (value.length > LIMITS.checkpointListItems) {
    errors.push(`${label} must have at most ${LIMITS.checkpointListItems} items (was ${value.length}); keep the ${LIMITS.checkpointListItems} most load-bearing entries`);
    valid = false;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${label}[${index}] must be a non-empty string`);
      valid = false;
      return;
    }
    const bytes = Buffer.byteLength(item, "utf8");
    if (bytes > LIMITS.checkpointItemBytes) {
      errors.push(`${label}[${index}] exceeds ${LIMITS.checkpointItemBytes} bytes (was ${bytes}); shorten the entry or move detail into \`data\``);
      valid = false;
      return;
    }
    out.push(item);
  });
  return valid ? { value: out, valid } : { valid: false };
}

function dataErrors(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isJsonValue(value)) {
    errors.push(`${label} must be a JSON value`);
    return;
  }
  if (jsonDepth(value) > LIMITS.jsonDepth) errors.push(`${label} nesting must not exceed ${LIMITS.jsonDepth} levels`);
}

function normalizedCheckpoint(raw: Record<string, unknown>, exemptsPlan: boolean): Checkpoint | undefined {
  if (typeof raw.summary !== "string" || !raw.summary.trim()) return undefined;
  const checkpoint: MutableCheckpoint = { summary: raw.summary };
  const list = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;
  const evidence = list(raw.evidence);
  const decisions = list(raw.decisions);
  const unknowns = list(raw.unknowns);
  if (evidence?.length) checkpoint.evidence = evidence;
  if (decisions?.length) checkpoint.decisions = decisions;
  if (unknowns?.length) checkpoint.unknowns = unknowns;
  if (isJsonValue(raw.data)) checkpoint.data = raw.data;
  if (raw.skipped === true) checkpoint.skipped = true;
  if (exemptsPlan && checkpoint.data !== undefined && typeof checkpoint.data === "object" && checkpoint.data !== null && !Array.isArray(checkpoint.data) && (checkpoint.data as { plan?: unknown }).plan !== undefined) {
    const rest: Record<string, unknown> = { ...(checkpoint.data as Record<string, unknown>) };
    delete rest.plan;
    if (Object.keys(rest).length === 0) delete checkpoint.data;
    else checkpoint.data = rest as JsonValue;
  }
  return checkpoint;
}

export function checkpointErrors(value: unknown, label: string, exemptsPlan = false): string[] {
  let raw: Record<string, unknown>;
  try {
    raw = objectAt(value, label);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(CHECKPOINT_KEYS as readonly string[]).includes(key)) errors.push(`${label}.${key} is not an accepted checkpoint field`);
  }
  if (raw.skipped !== undefined && raw.skipped !== true) errors.push(`${label}.skipped must be true when present`);
  if (typeof raw.summary !== "string" || !raw.summary.trim()) {
    errors.push(`${label}.summary must be a non-empty string`);
  } else {
    const bytes = Buffer.byteLength(raw.summary, "utf8");
    if (bytes > LIMITS.checkpointSummaryBytes) {
      errors.push(`${label}.summary exceeds ${LIMITS.checkpointSummaryBytes} bytes (was ${bytes}); move detail into \`evidence\` or \`data\``);
    }
  }
  boundedStringList(raw.evidence, `${label}.evidence`, errors);
  boundedStringList(raw.decisions, `${label}.decisions`, errors);
  boundedStringList(raw.unknowns, `${label}.unknowns`, errors);
  dataErrors(raw.data, `${label}.data`, errors);
  const normalized = normalizedCheckpoint(raw, exemptsPlan);
  if (normalized) {
    const bytes = canonicalJsonBytes(normalized as unknown as JsonValue);
    if (bytes > LIMITS.checkpointBytes) {
      errors.push(`${label} exceeds ${LIMITS.checkpointBytes} bytes (was ${bytes}); trim \`evidence\`/\`decisions\`/\`unknowns\` or narrow \`data\``);
    }
  }
  return errors;
}

export function validateCheckpoint(value: unknown, label: string, exemptsPlan = false): Checkpoint {
  const errors = checkpointErrors(value, label, exemptsPlan);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const raw = objectAt(value, label);
  const checkpoint: MutableCheckpoint = {
    summary: requireString(raw.summary, `${label}.summary`),
  };
  const evidence = boundedStringList(raw.evidence, `${label}.evidence`, []).value;
  const decisions = boundedStringList(raw.decisions, `${label}.decisions`, []).value;
  const unknowns = boundedStringList(raw.unknowns, `${label}.unknowns`, []).value;
  const data = raw.data === undefined ? undefined : (raw.data as JsonValue);
  if (evidence) checkpoint.evidence = evidence;
  if (decisions) checkpoint.decisions = decisions;
  if (unknowns) checkpoint.unknowns = unknowns;
  if (data !== undefined) checkpoint.data = data;
  if (raw.skipped === true) checkpoint.skipped = true;
  return checkpoint;
}
