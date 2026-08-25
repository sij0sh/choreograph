import type { Execution } from "../domain/execution.ts";
import { deepEqual, isJsonValue, type JsonValue } from "../domain/json.ts";
import type { DataReference, Predicate, ValueSource } from "../domain/workflow.ts";
import { parseReference, resolveReference } from "./references.ts";

const OPERATIONS = ["equals", "exists", "contains", "not", "all", "any"] as const;
type Operation = (typeof OPERATIONS)[number];

export function parseValueSource(raw: unknown, label = "value"): ValueSource {
  if (typeof raw === "string" && raw.startsWith("$")) {
    return { ref: parseReference(raw, label) };
  }
  if (!isJsonValue(raw)) throw new Error(`${label} must be a reference ($ prefixed) or a JSON literal`);
  return { literal: raw };
}

function pairAt(raw: unknown, op: Operation): [unknown, unknown] {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${op} takes exactly two values`);
  return [raw[0], raw[1]];
}

export function parsePredicate(raw: unknown, label = "predicate"): Predicate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object with exactly one operation`);
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new Error(`${label} must carry exactly one of: ${OPERATIONS.join(", ")}`);
  const op = keys[0] as Operation;
  if (!OPERATIONS.includes(op)) throw new Error(`${label} operation must be one of: ${OPERATIONS.join(", ")}`);
  const value = (raw as Record<string, unknown>)[op];
  switch (op) {
    case "equals":
    case "contains": {
      const [left, right] = pairAt(value, op);
      const side = op === "equals" ? ["left", "right"] : ["container", "value"];
      return { op, [side[0]]: parseValueSource(left, `${label}.${op}[0]`), [side[1]]: parseValueSource(right, `${label}.${op}[1]`) } as Predicate;
    }
    case "exists":
      return { op, value: parseValueSource(value, `${label}.exists`) };
    case "not":
      return { op, predicate: parsePredicate(value, `${label}.not`) };
    case "all":
    case "any": {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}.${op} must be a non-empty list of predicates`);
      return { op, predicates: value.map((entry, index) => parsePredicate(entry, `${label}.${op}[${index}]`)) };
    }
  }
}

function sourceValue(state: Execution, source: ValueSource): JsonValue | undefined {
  return "ref" in source ? resolveReference(state, source.ref) : source.literal;
}

export function evaluatePredicate(state: Execution, predicate: Predicate): boolean {
  switch (predicate.op) {
    case "equals":
      return deepEqual(sourceValue(state, predicate.left), sourceValue(state, predicate.right));
    case "exists":
      return sourceValue(state, predicate.value) !== undefined;
    case "contains": {
      const container = sourceValue(state, predicate.container);
      const value = sourceValue(state, predicate.value);
      if (Array.isArray(container)) return container.some((entry) => deepEqual(entry, value));
      if (typeof container === "string" && typeof value === "string") return container.includes(value);
      return false;
    }
    case "not":
      return !evaluatePredicate(state, predicate.predicate);
    case "all":
      return predicate.predicates.every((entry) => evaluatePredicate(state, entry));
    case "any":
      return predicate.predicates.some((entry) => evaluatePredicate(state, entry));
  }
}
