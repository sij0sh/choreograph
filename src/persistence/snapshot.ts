import { isStructuralFrame, type Execution, type Frame } from "../domain/execution.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { validateCheckpoint } from "../domain/checkpoint.ts";
import { LIMITS } from "../domain/limits.ts";
import type { PlanExecution } from "../domain/execution.ts";
import type { JsonValue } from "../domain/json.ts";
import { isJsonValue, jsonDepth, objectAt, requireString } from "../domain/json.ts";
import type { NodeInvocation, NodeStatus, RunnerKind } from "../domain/node.ts";
import { loopFrameKeys, loopStateForFrame, RUN_STATE_FIELDS, RUN_STATE_SCHEMA } from "./run-state-schema.ts";

const NODE_STATUSES: readonly NodeStatus[] = ["running", "waiting", "succeeded", "failed", "canceled", "skipped"];
const RUNNER_KINDS: readonly RunnerKind[] = ["agent", "process"];

function invocationsAt(value: unknown, label: string): Record<string, NodeInvocation> {
  const raw = objectAt(value, label);
  const invocations: Record<string, NodeInvocation> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const item = objectAt(entry, `${label}.${key}`);
    for (const field of Object.keys(item)) {
      if (!(RUN_STATE_SCHEMA.invocations.entryFields as readonly string[]).includes(field)) {
        throw new Error(`${label}.${key}.${field} is not an accepted invocation field`);
      }
    }
    const invocationKey = requireString(item.key, `${label}.${key}.key`);
    if (invocationKey !== key) throw new Error(`${label}.${key}.key must match its map key`);
    const blockId = requireString(item.blockId, `${label}.${key}.blockId`);
    if (!RUNNER_KINDS.includes(item.runner as RunnerKind)) throw new Error(`${label}.${key}.runner must be one of: ${RUNNER_KINDS.join(", ")}`);
    if (!NODE_STATUSES.includes(item.status as NodeStatus)) throw new Error(`${label}.${key}.status must be one of: ${NODE_STATUSES.join(", ")}`);
    const attempt = item.attempt;
    const attemptMax = LIMITS.nodeAttempts + 1;
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > attemptMax) {
      throw new Error(`${label}.${key}.attempt must be an integer between 1 and ${attemptMax}`);
    }
    invocations[key] = { blockId, key: invocationKey, runner: item.runner as RunnerKind, status: item.status as NodeStatus, attempt };
  }
  return invocations;
}

export const SNAPSHOT_TYPE = "choreograph";

export type ActiveSnapshotV7 = {
  readonly v: 7;
  readonly status: "active";
  readonly workflow: string;
  readonly execution: Execution;
  readonly delivered: boolean;
  readonly baselineTools?: readonly string[];
};

type TerminalSnapshot =
  | { readonly v: 7; readonly status: "completed"; readonly workflow: string; readonly runId: string; readonly execution?: Execution }
  | { readonly v: 7; readonly status: "aborted"; readonly workflow: string; readonly runId: string; readonly execution?: Execution }

type RolloverSnapshotV6 = {
  readonly v: 6;
  readonly status: "rollover-pending";
  readonly workflow: string;
  readonly runId: string;
  readonly transferId: string;
};

export type ParsedSnapshot =
  | ActiveSnapshotV7
  | RolloverSnapshotV6
  | TerminalSnapshot
  | { readonly status: "terminal" }
  | { readonly status: "invalid"; readonly error: string };

const FRAME_KINDS = ["sequence", "task", "plan", "node", "loop"] as const;
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
      const attemptMax = LIMITS.nodeAttempts + 1;
      return { kind, blockId, key, mode: raw.mode, attempt: indexAt("attempt", attemptMax) || 1 };
    }
    case "node":
      return { kind, blockId, key, nodeId: requireString(raw.nodeId, `${label}.nodeId`), attempt: indexAt("attempt", LIMITS.nodeAttempts + 1) || 1 };
    case "loop":
      return { kind, blockId, key };
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
      if (!(RUN_STATE_SCHEMA.plans.entryFields as readonly string[]).includes(field)) throw new Error(`${label}.${key}.${field} is not an accepted plan field`);
    }
    const blockId = requireString(planRaw.blockId, `${label}.${key}.blockId`);
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
      plan: { version: 1, nodes: nodes as PlanExecution["plan"]["nodes"] },
      results,
    };
  }
  return plans;
}

function loopsAt(value: unknown, label: string): Record<string, Execution["loops"][string]> {
  const raw = objectAt(value, label);
  const loops: Record<string, Execution["loops"][string]> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const loopRaw = objectAt(entry, `${label}.${key}`);
    for (const field of Object.keys(loopRaw)) {
      if (!(RUN_STATE_SCHEMA.loops.entryFields as readonly string[]).includes(field)) throw new Error(`${label}.${key}.${field} is not an accepted loop field`);
    }
    const iteration = loopRaw.iteration;
    if (typeof iteration !== "number" || !Number.isInteger(iteration) || iteration < 1 || iteration > LIMITS.checkpointListItems) {
      throw new Error(`${label}.${key}.iteration must be an integer between 1 and ${LIMITS.checkpointListItems}`);
    }
    let items: readonly JsonValue[] | undefined;
    if (loopRaw.items !== undefined) {
      if (!Array.isArray(loopRaw.items)) throw new Error(`${label}.${key}.items must be a list`);
      if (loopRaw.items.length > LIMITS.checkpointListItems) throw new Error(`${label}.${key}.items must have at most ${LIMITS.checkpointListItems} entries`);
      if (loopRaw.items.some((item) => !isJsonValue(item))) throw new Error(`${label}.${key}.items entries must be JSON values`);
      items = loopRaw.items as readonly JsonValue[];
    }
    loops[key] = {
      iteration,
      ...(items !== undefined ? { items } : {}),
    };
  }
  return loops;
}

function executionAt(value: unknown, label: string): Execution {
  const raw = objectAt(value, label);
  for (const field of Object.keys(raw)) {
    if (!RUN_STATE_FIELDS.includes(field as keyof Execution)) {
      throw new Error(`${label}.${field} is not an accepted execution field`);
    }
  }
  if (raw.definitionDigest !== undefined && typeof raw.definitionDigest !== "string") {
    throw new Error(`${label}.definitionDigest must be a string`);
  }
  const status = raw.status;
  if (status !== "active") throw new Error(`${label}.status must be active`);
  const stack = stackAt(raw.stack, `${label}.stack`);
  const leaf = stack[stack.length - 1];
  if (isStructuralFrame(leaf)) throw new Error(`${label}.stack must end at a leaf frame (task, node, or plan creation)`);
  const checkpoints = checkpointsAt(raw.checkpoints ?? {}, `${label}.checkpoints`);
  const plans = plansAt(raw.plans ?? {}, `${label}.plans`);
  const loops = loopsAt(raw.loops ?? {}, `${label}.loops`);
  const invocations = raw.invocations === undefined ? undefined : invocationsAt(raw.invocations, `${label}.invocations`);
  for (const frame of stack) {
    if (frame.kind !== RUN_STATE_SCHEMA.loops.frameKind) continue;
    if (!loopStateForFrame({ loops }, frame)) throw new Error(`${label}.loops is missing state for loop frame ${frame.key}`);
  }
  const activeLoopKeys = loopFrameKeys(stack);
  for (const key of Object.keys(loops)) {
    if (!activeLoopKeys.has(key)) throw new Error(`${label}.loops[${key}] has no matching loop frame`);
  }
  const orderRaw = raw.checkpointOrder === undefined ? Object.keys(checkpoints) : raw.checkpointOrder;
  if (!Array.isArray(orderRaw) || orderRaw.some((key) => typeof key !== "string")) throw new Error(`${label}.checkpointOrder must be a list of checkpoint keys`);
  const ordered = new Set(orderRaw);
  if (ordered.size !== orderRaw.length) throw new Error(`${label}.checkpointOrder must not contain duplicates`);
  const known = new Set(Object.keys(checkpoints));
  for (const key of orderRaw) {
    if (!known.has(key)) throw new Error(`${label}.checkpointOrder entry "${key}" has no checkpoint`);
  }
  for (const key of Object.keys(checkpoints)) {
    if (!ordered.has(key)) throw new Error(`${label}.checkpoints entry "${key}" is missing from checkpointOrder`);
  }
  const decoded = {
    workflowName: requireString(raw.workflowName, `${label}.workflowName`),
    runId: requireString(raw.runId, `${label}.runId`),
    target: typeof raw.target === "string" && Buffer.byteLength(raw.target, "utf8") <= LIMITS.targetBytes ? raw.target : "",
    status: "active" as const,
    stack,
    checkpoints,
    checkpointOrder: orderRaw,
    plans,
    loops,
    definitionDigest: raw.definitionDigest as string | undefined,
    invocations,
  } satisfies { [K in Exclude<keyof Execution, "definitionDigest" | "invocations">]-?: Execution[K] } & {
    definitionDigest: Execution["definitionDigest"];
    invocations: Execution["invocations"];
  };
  const projected: Record<string, unknown> = {};
  for (const field of RUN_STATE_FIELDS) {
    const fieldValue = decoded[field];
    if (fieldValue !== undefined) projected[field] = fieldValue;
  }
  return projected as unknown as Execution;
}

export function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const snapshot = data as Record<string, unknown>;
  if (snapshot.status === "completed" || snapshot.status === "aborted") return { status: "terminal" };
  if (snapshot.status === "rollover-pending") {
    if (snapshot.v !== 6 || typeof snapshot.workflow !== "string" || typeof snapshot.runId !== "string" || typeof snapshot.transferId !== "string") {
      return { status: "invalid", error: "rollover snapshot fields are invalid" };
    }
    return { v: 6, status: "rollover-pending", workflow: snapshot.workflow, runId: snapshot.runId, transferId: snapshot.transferId };
  }
  if (snapshot.status !== "active") return null;
  if (snapshot.v !== 7) {
    return { status: "invalid", error: "snapshot version must be 7; snapshots from earlier engine versions are not resumable; start the workflow again" };
  }
  try {
    const execution = executionAt(snapshot.execution, "snapshot.execution");
    if (execution.workflowName !== snapshot.workflow) throw new Error("snapshot.workflow does not match snapshot.execution.workflowName");
    if (typeof snapshot.delivered !== "boolean") throw new Error("snapshot.delivered must be a boolean");
    if (snapshot.baselineTools !== undefined) {
      if (
        !Array.isArray(snapshot.baselineTools) ||
        snapshot.baselineTools.some((name) => typeof name !== "string" || name.length === 0)
      ) {
        throw new Error("snapshot.baselineTools must be a list of tool names");
      }
    }
    const baselineTools = snapshot.baselineTools as string[] | undefined;
    return {
      v: 7,
      status: "active",
      workflow: execution.workflowName,
      execution,
      delivered: snapshot.delivered as boolean,
      ...(baselineTools ? { baselineTools } : {}),
    };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export function activeSnapshot(fields: {
  workflow: string;
  execution: Execution;
  delivered: boolean;
  baselineTools?: readonly string[];
}): ActiveSnapshotV7 {
  return {
    v: 7,
    status: "active",
    workflow: fields.workflow,
    execution: fields.execution,
    delivered: fields.delivered,
    ...(fields.baselineTools ? { baselineTools: [...new Set(fields.baselineTools)] } : {}),
  };
}

export function rolloverSnapshot(workflow: string, runId: string, transferId: string): RolloverSnapshotV6 {
  return { v: 6, status: "rollover-pending", workflow, runId, transferId };
}

/**
 * O(1) delivered marker (fx5b): records that a run's instructions were delivered
 * without re-committing the full state. Readers accept both this and the legacy
 * full active snapshot with `delivered: true`.
 */
export type DeliveredTombstone = {
  readonly v: 1;
  readonly kind: "delivered";
  readonly runId: string;
};

export function deliveredTombstone(runId: string): DeliveredTombstone {
  return { v: 1, kind: "delivered", runId };
}

export function isDeliveredTombstone(data: unknown): data is DeliveredTombstone {
  if (typeof data !== "object" || data === null) return false;
  const tombstone = data as Record<string, unknown>;
  return tombstone.v === 1 && tombstone.kind === "delivered" && typeof tombstone.runId === "string";
}

export function terminalSnapshot(
  status: "completed" | "aborted",
  workflow: string,
  runId: string,
  execution?: Execution,
): TerminalSnapshot {
  return { v: 7, status, workflow, runId, ...(execution ? { execution } : {}) };
}
