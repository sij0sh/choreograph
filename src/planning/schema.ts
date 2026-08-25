import { validateCheckpoint } from "../domain/checkpoint.ts";
import type { JsonValue } from "../domain/json.ts";
import { canonicalJsonBytes } from "../domain/json.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";

export interface PlanNode {
  readonly id: string;
  readonly operator: string;
  readonly objective: string;
  readonly dependsOn?: readonly string[];
  readonly evidence?: readonly string[];
  readonly done: readonly string[];
}

export interface DynamicPlan {
  readonly version: 1;
  readonly nodes: readonly PlanNode[];
}

export interface NodeResult {
  readonly id: string;
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly decisions?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly data?: import("../domain/json.ts").JsonValue;
}

export function validateNodeResult(value: unknown, label: string): NodeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["id", "summary", "evidence", "decisions", "unknowns", "data"].includes(key)) throw new Error(`${label}.${key} is not an accepted result field`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${label}.id must match ${ID_PATTERN}`);
  const { id: _omitted, ...checkpointFields } = raw;
  const checkpoint = validateCheckpoint(checkpointFields, label);
  const result: NodeResult = {
    id,
    summary: checkpoint.summary,
    ...(checkpoint.evidence ? { evidence: checkpoint.evidence } : {}),
    ...(checkpoint.decisions ? { decisions: checkpoint.decisions } : {}),
    ...(checkpoint.unknowns ? { unknowns: checkpoint.unknowns } : {}),
    ...(checkpoint.data !== undefined ? { data: checkpoint.data } : {}),
  };
  if (canonicalJsonBytes(result as unknown as JsonValue) > LIMITS.nodeResultBytes) {
    throw new Error(`${label} exceeds ${LIMITS.nodeResultBytes} bytes`);
  }
  return result;
}
