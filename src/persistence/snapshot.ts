import { isStructuralFrame, type Run, type Frame,
  type SequenceFrame, type TaskFrame, type PlanFrame, type PlanNodeFrame, type LoopFrame } from "../domain/run.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { validateCheckpoint } from "../domain/checkpoint.ts";
import { LIMITS } from "../domain/limits.ts";
import type { PlanRecord } from "../domain/run.ts";
import type { JsonValue } from "../domain/json.ts";
import { isJsonValue, jsonDepth, objectAt, requireString } from "../domain/json.ts";
import type { Invocation, InvocationStatus, RunnerKind } from "../domain/invocation.ts";
import { loopFrameKeys, loopStateForFrame, RUN_STATE_FIELDS, RUN_STATE_SCHEMA } from "./run-state-schema.ts";
import type { RunLifecycleStatus } from "../domain/run.ts";

/**
 * A decode allowlist is exhaustiveness-linked to its domain union: a stale
 * member or a missing union member fails compilation, so the list cannot
 * drift from its owner.
 */
type ExhaustiveMembers<T extends readonly string[], U extends string> =
  [T[number]] extends [U] ? ([Exclude<U, T[number]>] extends [never] ? T : never) : never;

export const NODE_STATUSES: ExhaustiveMembers<
  readonly ["running", "waiting", "succeeded", "failed", "canceled", "skipped"],
  InvocationStatus
> = ["running", "waiting", "succeeded", "failed", "canceled", "skipped"] as const;

export const RUNNER_KINDS: ExhaustiveMembers<readonly ["agent", "process"], RunnerKind> = ["agent", "process"] as const;

function invocationsAt(value: unknown, label: string): Record<string, Invocation> {
  const raw = objectAt(value, label);
  const invocations: Record<string, Invocation> = {};
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
    if (!NODE_STATUSES.includes(item.status as InvocationStatus)) throw new Error(`${label}.${key}.status must be one of: ${NODE_STATUSES.join(", ")}`);
    const attempt = item.attempt;
    const attemptMax = LIMITS.nodeAttempts + 1;
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > attemptMax) {
      throw new Error(`${label}.${key}.attempt must be an integer between 1 and ${attemptMax}`);
    }
    invocations[key] = { blockId, key: invocationKey, runner: item.runner as RunnerKind, status: item.status as InvocationStatus, attempt };
  }
  return invocations;
}

export const SNAPSHOT_TYPE = "choreograph";

export type ActiveSnapshotV7 = {
  readonly v: 7;
  readonly status: "active";
  readonly workflow: string;
  readonly execution: Run;
  readonly delivered: boolean;
  readonly baselineTools?: readonly string[];
};

/** A parked run keeps its full execution; only the status differs from active. */
export type PausedSnapshotV7 = Omit<ActiveSnapshotV7, "status"> & { readonly status: "paused" };

type TerminalSnapshot =
  | { readonly v: 7; readonly status: "completed"; readonly workflow: string; readonly runId: string; readonly execution?: Run }
  | { readonly v: 7; readonly status: "aborted"; readonly workflow: string; readonly runId: string; readonly execution?: Run }

type RolloverSnapshotV6 = {
  readonly v: 6;
  readonly status: "rollover-pending";
  readonly workflow: string;
  readonly runId: string;
  readonly transferId: string;
};

export type ParsedSnapshot =
  | ActiveSnapshotV7
  | PausedSnapshotV7
  | RolloverSnapshotV6
  | TerminalSnapshot
  | { readonly status: "terminal" }
  | { readonly status: "invalid"; readonly error: string };

interface FrameSeed {
  readonly blockId: string;
  readonly key: string;
}

function intAt(raw: Record<string, unknown>, label: string, field: string, max: number): number {
  const n = raw[field];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) throw new Error(`${label}.${field} must be an integer between 0 and ${max}`);
  return n;
}

/** One decoder per frame kind; the mapped satisfies clause is the compile link between the decode table and the Frame union. */
const FRAME_DECODERS = {
  sequence: (seed: FrameSeed, raw: Record<string, unknown>, label: string): SequenceFrame =>
    ({ kind: "sequence", ...seed, index: intAt(raw, label, "index", 100_000) }),
  task: (seed: FrameSeed, raw: Record<string, unknown>, label: string): TaskFrame =>
    ({ kind: "task", ...seed, attempt: intAt(raw, label, "attempt", LIMITS.nodeAttempts + 1) || 1 }),
  plan: (seed: FrameSeed, raw: Record<string, unknown>, label: string): PlanFrame => {
    if (raw.mode !== "create" && raw.mode !== "execute") throw new Error(`${label}.mode must be create or execute`);
    return { kind: "plan", ...seed, mode: raw.mode, attempt: intAt(raw, label, "attempt", LIMITS.nodeAttempts + 1) || 1 };
  },
  node: (seed: FrameSeed, raw: Record<string, unknown>, label: string): PlanNodeFrame =>
    ({ kind: "node", ...seed, nodeId: requireString(raw.nodeId, `${label}.nodeId`), attempt: intAt(raw, label, "attempt", LIMITS.nodeAttempts + 1) || 1 }),
  loop: (seed: FrameSeed): LoopFrame => ({ kind: "loop", ...seed }),
} as const satisfies { [K in Frame["kind"]]: (seed: FrameSeed, raw: Record<string, unknown>, label: string) => Extract<Frame, { kind: K }> };

export const FRAME_KINDS = Object.keys(FRAME_DECODERS) as Frame["kind"][];

function frameAt(value: unknown, label: string): Frame {
  const raw = objectAt(value, label);
  const decode = FRAME_DECODERS[raw.kind as Frame["kind"]];
  if (!decode) throw new Error(`${label}.kind must be one of: ${FRAME_KINDS.join(", ")}`);
  const seed: FrameSeed = { blockId: requireString(raw.blockId, `${label}.blockId`), key: requireString(raw.key, `${label}.key`) };
  return decode(seed, raw, label);
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

function plansAt(value: unknown, label: string): Record<string, PlanRecord> {
  const raw = objectAt(value, label);
  const plans: Record<string, PlanRecord> = {};
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
    const results: Record<string, PlanRecord["results"][string]> = {};
    for (const [id, value] of Object.entries(resultsRaw)) {
      const result = validateCheckpoint(value, `${label}.${key}.results.${id}`);
      results[id] = result;
    }
    plans[key] = {
      blockId,
      plan: { version: 1, nodes: nodes as PlanRecord["plan"]["nodes"] },
      results,
    };
  }
  return plans;
}

function loopsAt(value: unknown, label: string): Record<string, Run["loops"][string]> {
  const raw = objectAt(value, label);
  const loops: Record<string, Run["loops"][string]> = {};
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

/** Decodes the persisted run state. The JSON key `execution` is frozen at snapshot v7. */
function runAt(value: unknown, label: string): Run {
  const raw = objectAt(value, label);
  for (const field of Object.keys(raw)) {
    if (!RUN_STATE_FIELDS.includes(field as keyof Run)) {
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
  } satisfies { [K in Exclude<keyof Run, "definitionDigest" | "invocations">]-?: Run[K] } & {
    definitionDigest: Run["definitionDigest"];
    invocations: Run["invocations"];
  };
  const projected: Record<string, unknown> = {};
  for (const field of RUN_STATE_FIELDS) {
    const fieldValue = decoded[field];
    if (fieldValue !== undefined) projected[field] = fieldValue;
  }
  return projected as unknown as Run;
}

function terminalAt(): ParsedSnapshot | null {
  return { status: "terminal" };
}

function rolloverAt(snapshot: Record<string, unknown>): ParsedSnapshot | null {
  if (snapshot.v !== 6 || typeof snapshot.workflow !== "string" || typeof snapshot.runId !== "string" || typeof snapshot.transferId !== "string") {
    return { status: "invalid", error: "rollover snapshot fields are invalid" };
  }
  return { v: 6, status: "rollover-pending", workflow: snapshot.workflow, runId: snapshot.runId, transferId: snapshot.transferId };
}

function liveSnapshotAt(status: "active" | "paused", snapshot: Record<string, unknown>): ParsedSnapshot | null {
  if (snapshot.v !== 7) {
    return { status: "invalid", error: "snapshot version must be 7; snapshots from earlier engine versions are not resumable; start the workflow again" };
  }
  try {
    const run = runAt(snapshot.execution, "snapshot.execution");
    if (run.workflowName !== snapshot.workflow) throw new Error("snapshot.workflow does not match snapshot.execution.workflowName");
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
      status,
      workflow: run.workflowName,
      execution: run,
      delivered: snapshot.delivered as boolean,
      ...(baselineTools ? { baselineTools } : {}),
    };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

/** One decoder per snapshot status; the mapped type is the compile link: a lifecycle status without a parse row fails compilation. */
const SNAPSHOT_STATUS_DECODERS: { [S in RunLifecycleStatus | "rollover-pending"]: (snapshot: Record<string, unknown>) => ParsedSnapshot | null } = {
  active: (snapshot) => liveSnapshotAt("active", snapshot),
  paused: (snapshot) => liveSnapshotAt("paused", snapshot),
  completed: terminalAt,
  aborted: terminalAt,
  "rollover-pending": rolloverAt,
};

export function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const snapshot = data as Record<string, unknown>;
  // corr-c14: an unknown string status means a corrupt choreograph snapshot;
  // report it instead of dropping the run silently. A missing or non-string
  // status keeps returning null so foreign session entries stay skipped.
  if (typeof snapshot.status !== "string") return null;
  const decode = SNAPSHOT_STATUS_DECODERS[snapshot.status as RunLifecycleStatus | "rollover-pending"];
  return decode ? decode(snapshot) : { status: "invalid", error: `unknown snapshot status ${JSON.stringify(snapshot.status)}` };
}

export function activeSnapshot(fields: {
  workflow: string;
  execution: Run;
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

export function pausedSnapshot(fields: {
  workflow: string;
  execution: Run;
  delivered: boolean;
  baselineTools?: readonly string[];
}): PausedSnapshotV7 {
  return { ...activeSnapshot(fields), status: "paused" };
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

/**
 * O(1) pause marker: parks a run when its full state cannot be committed
 * (memory bound, session caps). Readers fold it into the last active snapshot
 * of the same run, like the delivered tombstone.
 */
export type PausedMarker = {
  readonly v: 1;
  readonly kind: "paused";
  readonly runId: string;
};

export function pausedMarker(runId: string): PausedMarker {
  return { v: 1, kind: "paused", runId };
}

export function isPausedMarker(data: unknown): data is PausedMarker {
  if (typeof data !== "object" || data === null) return false;
  const marker = data as Record<string, unknown>;
  return marker.v === 1 && marker.kind === "paused" && typeof marker.runId === "string";
}

export function terminalSnapshot(
  status: "completed" | "aborted",
  workflow: string,
  runId: string,
  execution?: Run,
): TerminalSnapshot {
  return { v: 7, status, workflow, runId, ...(execution ? { execution } : {}) };
}
