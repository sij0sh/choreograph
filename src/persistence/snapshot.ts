import type { Execution, Frame } from "../domain/execution.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { validateCheckpoint } from "../domain/checkpoint.ts";
import { LIMITS, PLAN_CREATE_ATTEMPT_MAX } from "../domain/limits.ts";
import type { PlanExecution } from "../domain/execution.ts";
import type { JsonValue } from "../domain/json.ts";
import { isJsonValue, jsonDepth, objectAt, requireString } from "../domain/json.ts";

export const SNAPSHOT_TYPE = "choreograph";

export type ActiveSnapshotV5 = {
  readonly v: 5;
  readonly status: "active";
  readonly workflow: string;
  readonly execution: Execution;
  readonly delivered: boolean;
};

type TerminalSnapshot =
  | { readonly v: 5; readonly status: "completed"; readonly workflow: string; readonly runId: string }
  | { readonly v: 5; readonly status: "aborted"; readonly workflow: string; readonly runId: string };

export type ParsedSnapshot =
  | ActiveSnapshotV5
  | TerminalSnapshot
  | { readonly status: "terminal" }
  | { readonly status: "invalid"; readonly error: string };

const FRAME_KINDS = ["sequence", "task", "plan", "node"] as const;
type FrameKind = (typeof FRAME_KINDS)[number];

function frameAt(value: unknown, label: string): Frame {
  const raw = objectAt(value, label);
  if (!FRAME_KINDS.includes(raw.kind as FrameKind)) throw new Error(`${label}.kind must be one of: ${FRAME_KINDS.join(", ")}`);
  const kind = raw.kind as FrameKind;
  const blockId = requireString(raw.blockId, `${label}.blockId`);
  const key = requireString(raw.key, `${label}.key`);
  const indexAt = (field: string, max: number): number => {
    const n = raw[field];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) throw new Error(`${label}.${field} must be an integer between 0 and ${max}`);
    return n;
  };
  switch (kind) {
    case "sequence":
      return { kind, blockId, key, index: indexAt("index", 100_000) };
    case "task":
      return { kind, blockId, key, attempt: indexAt("attempt", LIMITS.nodeAttempts + 1) || 1 };
    case "plan": {
      if (raw.mode !== "create" && raw.mode !== "execute") throw new Error(`${label}.mode must be create or execute`);
      const attemptMax = raw.mode === "create" ? PLAN_CREATE_ATTEMPT_MAX : LIMITS.nodeAttempts + 1;
      return { kind, blockId, key, mode: raw.mode, attempt: indexAt("attempt", attemptMax) || 1 };
    }
    case "node":
      return { kind, blockId, key, nodeId: requireString(raw.nodeId, `${label}.nodeId`), attempt: indexAt("attempt", LIMITS.nodeAttempts + 1) || 1 };
  }
}

function stackAt(value: unknown, label: string): Frame[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  if (value.length > LIMITS.stackDepth) throw new Error(`${label} exceeds ${LIMITS.stackDepth} frames`);
  return value.map((entry, index) => frameAt(entry, `${label}[${index}]`));
}

function checkpointsAt(value: unknown, label: string): Record<string, Checkpoint> {
  const raw = objectAt(value, label);
  const checkpoints: Record<string, Checkpoint> = {};
  for (const [key, entry] of Object.entries(raw)) {
    checkpoints[key] = validateCheckpoint(entry, `${label}.${key}`);
  }
  return checkpoints;
}

function plansAt(value: unknown, label: string): Record<string, PlanExecution> {
  const raw = objectAt(value, label);
  const plans: Record<string, PlanExecution> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const planRaw = objectAt(entry, `${label}.${key}`);
    for (const field of Object.keys(planRaw)) {
      if (!["blockId", "revision", "replans", "invalidations", "awaitingPlan", "plan", "results"].includes(field)) throw new Error(`${label}.${key}.${field} is not an accepted plan field`);
    }
    if (planRaw.awaitingPlan !== undefined && typeof planRaw.awaitingPlan !== "boolean") throw new Error(`${label}.${key}.awaitingPlan must be a boolean`);
    const blockId = requireString(planRaw.blockId, `${label}.${key}.blockId`);
    const revision = planRaw.revision;
    const replans = planRaw.replans;
    const invalidations = planRaw.invalidations ?? 0;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) throw new Error(`${label}.${key}.revision must be a positive integer`);
    if (typeof replans !== "number" || !Number.isInteger(replans) || replans < 0 || replans > LIMITS.replans) {
      throw new Error(`${label}.${key}.replans must be an integer between 0 and ${LIMITS.replans}`);
    }
    if (typeof invalidations !== "number" || !Number.isInteger(invalidations) || invalidations < 0 || invalidations > LIMITS.replans) {
      throw new Error(`${label}.${key}.invalidations must be an integer between 0 and ${LIMITS.replans}`);
    }
    const plan = planRaw.plan;
    if (!plan || typeof plan !== "object") throw new Error(`${label}.${key}.plan must be an object`);
    if ((plan as { version?: unknown }).version !== 1) throw new Error(`${label}.${key}.plan.version must be 1`);
    const nodes = (plan as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) throw new Error(`${label}.${key}.plan.nodes must be a list`);
    const resultsRaw = objectAt(planRaw.results, `${label}.${key}.results`);
    const results: Record<string, PlanExecution["results"][string]> = {};
    for (const [id, value] of Object.entries(resultsRaw)) {
      const result = validateCheckpoint(value, `${label}.${key}.results.${id}`);
      results[id] = result;
    }
    plans[key] = {
      blockId,
      revision,
      replans,
      invalidations,
      ...(planRaw.awaitingPlan === true ? { awaitingPlan: true } : {}),
      plan: { version: 1, nodes: nodes as PlanExecution["plan"]["nodes"] },
      results,
    };
  }
  return plans;
}

function executionAt(value: unknown, label: string): Execution {
  const raw = objectAt(value, label);
  for (const field of Object.keys(raw)) {
    if (!["workflowName", "runId", "target", "status", "stack", "checkpoints", "checkpointOrder", "plans"].includes(field)) {
      throw new Error(`${label}.${field} is not an accepted execution field`);
    }
  }
  const status = raw.status;
  if (status !== "active") throw new Error(`${label}.status must be active`);
  const stack = stackAt(raw.stack, `${label}.stack`);
  const leaf = stack[stack.length - 1];
  const leafKind = leaf.kind;
  const structural = leafKind === "sequence" || (leafKind === "plan" && leaf.mode === "execute");
  if (structural) throw new Error(`${label}.stack must end at a leaf frame (task, node, or plan creation)`);
  const checkpoints = checkpointsAt(raw.checkpoints ?? {}, `${label}.checkpoints`);
  const plans = plansAt(raw.plans ?? {}, `${label}.plans`);
  const orderRaw = raw.checkpointOrder === undefined ? Object.keys(checkpoints) : raw.checkpointOrder;
  if (!Array.isArray(orderRaw) || orderRaw.some((key) => typeof key !== "string")) throw new Error(`${label}.checkpointOrder must be a list of checkpoint keys`);
  if (new Set(orderRaw).size !== orderRaw.length) throw new Error(`${label}.checkpointOrder must not contain duplicates`);
  const known = new Set(Object.keys(checkpoints));
  for (const key of orderRaw) {
    if (!known.has(key)) throw new Error(`${label}.checkpointOrder entry "${key}" has no checkpoint`);
  }
  for (const key of Object.keys(checkpoints)) {
    if (!orderRaw.includes(key)) throw new Error(`${label}.checkpoints entry "${key}" is missing from checkpointOrder`);
  }
  return {
    workflowName: requireString(raw.workflowName, `${label}.workflowName`),
    runId: requireString(raw.runId, `${label}.runId`),
    target: typeof raw.target === "string" && Buffer.byteLength(raw.target, "utf8") <= LIMITS.targetBytes ? raw.target : "",
    status: "active",
    stack,
    checkpoints,
    checkpointOrder: orderRaw,
    plans,
  };
}

export function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const snapshot = data as Record<string, unknown>;
  if (snapshot.status === "completed" || snapshot.status === "aborted") return { status: "terminal" };
  if (snapshot.status !== "active") return null;
  if (snapshot.v !== 5) {
    return { status: "invalid", error: "snapshot version must be 5; snapshots from earlier engine versions are not resumable" };
  }
  try {
    const execution = executionAt(snapshot.execution, "snapshot.execution");
    if (execution.workflowName !== snapshot.workflow) throw new Error("snapshot.workflow does not match snapshot.execution.workflowName");
    if (typeof snapshot.delivered !== "boolean") throw new Error("snapshot.delivered must be a boolean");
    return {
      v: 5,
      status: "active",
      workflow: execution.workflowName,
      execution,
      delivered: snapshot.delivered as boolean,
    };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export function activeSnapshot(fields: {
  workflow: string;
  execution: Execution;
  delivered: boolean;
}): ActiveSnapshotV5 {
  return {
    v: 5,
    status: "active",
    workflow: fields.workflow,
    execution: fields.execution,
    delivered: fields.delivered,
  };
}

export function terminalSnapshot(status: "completed" | "aborted", workflow: string, runId: string): TerminalSnapshot {
  return { v: 5, status, workflow, runId };
}
