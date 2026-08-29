import { canonicalJson, jsonPointerGet, type JsonValue } from "./json.ts";
import type { Execution } from "./execution.ts";
import type { Workflow } from "./workflow.ts";
import { producerArtifact } from "./artifacts.ts";

export const GUARD_OPS = [
  "equals",
  "not-equals",
  "in",
  "not-in",
  "exists",
  "not-exists",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export type GuardOp = (typeof GUARD_OPS)[number];

export const VALUE_OPS: readonly GuardOp[] = ["equals", "not-equals", "in", "not-in", "gt", "gte", "lt", "lte"];

export interface GuardClause {
  readonly from: string;
  readonly select?: string;
  readonly op: GuardOp;
  readonly value?: JsonValue;
}

type GuardResult = { readonly ok: true; readonly holds: boolean } | { readonly ok: false; readonly error: string };

function canonicalMember(list: readonly JsonValue[], value: JsonValue): boolean {
  const form = canonicalJson(value);
  return list.some((entry) => canonicalJson(entry) === form);
}

function finiteNumber(value: JsonValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function operand(
  workflow: Workflow,
  state: Execution,
  guard: GuardClause,
): { ok: true; present: true; value: JsonValue } | { ok: true; present: false } | { ok: false; error: string } {
  const artifact = producerArtifact(workflow, state, guard.from);
  if (!artifact.ok) return { ok: false, error: artifact.error };
  if (!artifact.present) return { ok: true, present: false };
  if (guard.select === undefined) return { ok: true, present: true, value: artifact.value };
  const selected = jsonPointerGet(artifact.value, guard.select);
  if (!selected.ok) return { ok: true, present: false };
  return { ok: true, present: true, value: selected.value };
}

function valueHolds(guard: GuardClause, value: JsonValue): boolean {
  const expected = guard.value;
  switch (guard.op) {
    case "equals":
      return canonicalJson(value) === canonicalJson(expected as JsonValue);
    case "not-equals":
      return canonicalJson(value) !== canonicalJson(expected as JsonValue);
    case "in":
      return canonicalMember((expected ?? []) as readonly JsonValue[], value);
    case "not-in":
      return !canonicalMember((expected ?? []) as readonly JsonValue[], value);
    case "gt":
      return finiteNumber(value) && finiteNumber(expected as number) && value > (expected as number);
    case "gte":
      return finiteNumber(value) && finiteNumber(expected as number) && value >= (expected as number);
    case "lt":
      return finiteNumber(value) && finiteNumber(expected as number) && value < (expected as number);
    case "lte":
      return finiteNumber(value) && finiteNumber(expected as number) && value <= (expected as number);
    default:
      return false;
  }
}

export function evaluateGuard(workflow: Workflow, state: Execution, guard: GuardClause): GuardResult {
  const found = operand(workflow, state, guard);
  if (!found.ok) return { ok: false, error: found.error };
  switch (guard.op) {
    case "exists":
      return { ok: true, holds: found.present };
    case "not-exists":
      return { ok: true, holds: !found.present };
    default: {
      if (!found.present) return { ok: true, holds: false };
      return { ok: true, holds: valueHolds(guard, found.value) };
    }
  }
}

export function skipReason(guard: GuardClause): string {
  const source = guard.select === undefined ? guard.from : `${guard.from}${guard.select}`;
  const expected =
    guard.op === "exists" || guard.op === "not-exists"
      ? ""
      : ` against ${canonicalJson(guard.value as JsonValue)}`;
  return `Skipped: ${source} ${guard.op.replace("-", " ")}${expected} does not hold.`;
}
