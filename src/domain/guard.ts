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

/** Names an operand for guard errors: type plus a short sample of the value. */
function describeOperand(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const rendered = JSON.stringify(value) ?? "";
  return typeof value === "string" && rendered.length > 48 ? "a string" : `${typeof value} ${rendered}`;
}

type ValueHold = { readonly holds: boolean } | { readonly error: string };

function valueHolds(guard: GuardClause, source: string, value: JsonValue): ValueHold {
  const expected = guard.value;
  switch (guard.op) {
    case "equals":
      return { holds: canonicalJson(value) === canonicalJson(expected as JsonValue) };
    case "not-equals":
      return { holds: canonicalJson(value) !== canonicalJson(expected as JsonValue) };
    case "in":
    case "not-in": {
      if (!Array.isArray(expected)) return { error: `guard op "${guard.op}" needs an array value; the configured value is ${describeOperand(expected as JsonValue)}` };
      const holds = canonicalMember(expected, value);
      return { holds: guard.op === "in" ? holds : !holds };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (!finiteNumber(value)) return { error: `guard op "${guard.op}" needs a finite number; ${source} is ${describeOperand(value)}` };
      if (!finiteNumber(expected as JsonValue)) return { error: `guard op "${guard.op}" needs a finite number; the configured value is ${describeOperand(expected as JsonValue)}` };
      const actual = value;
      switch (guard.op) {
        case "gt":
          return { holds: actual > (expected as number) };
        case "gte":
          return { holds: actual >= (expected as number) };
        case "lt":
          return { holds: actual < (expected as number) };
        default:
          return { holds: actual <= (expected as number) };
      }
    }
    default:
      return { error: `guard op "${guard.op}" is not a value op` };
  }
}

export function evaluateGuard(workflow: Workflow, state: Execution, guard: GuardClause): GuardResult {
  const found = operand(workflow, state, guard);
  if (!found.ok) return { ok: false, error: found.error };
  const source = guardSource(guard);
  switch (guard.op) {
    case "exists":
      return { ok: true, holds: found.present };
    case "not-exists":
      return { ok: true, holds: !found.present };
    default: {
      // corr-c2: a value op over a missing operand is a config error, not a skip.
      if (!found.present) return { ok: false, error: `${source} not found for ${guard.op}` };
      const evaluated = valueHolds(guard, source, found.value);
      return "error" in evaluated ? { ok: false, error: evaluated.error } : { ok: true, holds: evaluated.holds };
    }
  }
}

export function guardSource(guard: GuardClause): string {
  return guard.select === undefined ? guard.from : `${guard.from}${guard.select}`;
}

export function skipReason(guard: GuardClause): string {
  const source = guardSource(guard);
  const expected =
    guard.op === "exists" || guard.op === "not-exists"
      ? ""
      : ` against ${canonicalJson(guard.value as JsonValue)}`;
  return `Skipped: ${source} ${guard.op.replace("-", " ")}${expected} does not hold.`;
}
