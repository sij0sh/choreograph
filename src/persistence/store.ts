import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import { isDeliveredTombstone, SNAPSHOT_TYPE, parseSnapshot, type ActiveSnapshotV7, type ParsedSnapshot } from "./snapshot.ts";

export class WorkflowStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`workflow ${operation} was not committed to session storage: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowStorageError";
  }
}

/** Raised before an append that would exceed the per-session snapshot entry cap. */
export class SnapshotCapReached extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`the session reached its ${limit}-snapshot cap (LIMITS.snapshotEntriesPerSession)`);
    this.name = "SnapshotCapReached";
    this.limit = limit;
  }
}

/** Raised before an append that would exceed the per-session snapshot byte budget. */
export class SnapshotByteBudgetReached extends Error {
  readonly budget: number;
  /** Projected serialized total that crossed the budget, including the rejected commit. */
  readonly bytes: number;
  constructor(budget: number, bytes: number) {
    super(`the session's snapshot log would exceed its ${budget}-byte budget (LIMITS.snapshotBytesPerSession)`);
    this.name = "SnapshotByteBudgetReached";
    this.budget = budget;
    this.bytes = bytes;
  }
}

/** Counts choreograph snapshot entries in a session branch (cheap counter input). */
export function countSnapshotEntries(branch: readonly unknown[]): number {
  let count = 0;
  for (const entry of branch) {
    const item = entry as { type?: unknown; customType?: unknown };
    if (item.type === "custom" && item.customType === SNAPSHOT_TYPE) count += 1;
  }
  return count;
}

/**
 * Serialized payload bytes of every snapshot entry in a session branch (fx5a):
 * the restore-side half of the per-session byte budget, so a resumed or
 * rollover-seeded session continues accounting from the bytes already on disk.
 */
export function snapshotBytesInBranch(branch: readonly unknown[]): number {
  let bytes = 0;
  for (const entry of branch) {
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type === "custom" && item.customType === SNAPSHOT_TYPE && item.data !== undefined) {
      bytes += Buffer.byteLength(JSON.stringify(item.data), "utf8");
    }
  }
  return bytes;
}

export interface SnapshotStore {
  append(snapshot: unknown): void;
}

export function withinMemoryBound(snapshot: ActiveSnapshotV7): boolean {
  const bytes = canonicalJsonBytes({
    checkpoints: snapshot.execution.checkpoints,
    checkpointOrder: snapshot.execution.checkpointOrder,
    plans: snapshot.execution.plans,
    loops: snapshot.execution.loops,
  } as unknown as JsonValue);
  return bytes <= LIMITS.memoryBytes;
}

/**
 * Latest resumable snapshot state. Accepts both delivered-marker formats (fx5b):
 * a tombstone folds `delivered: true` into the active snapshot of the run it names;
 * a legacy full snapshot already carries the flag.
 */
export function latestSnapshot(branch: readonly unknown[]): ParsedSnapshot | null {
  let deliveredRunId: string | undefined;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE) continue;
    if (isDeliveredTombstone(entry.data)) {
      deliveredRunId ??= entry.data.runId;
      continue;
    }
    const parsed = parseSnapshot(entry.data);
    if (parsed?.status === "active" && deliveredRunId === parsed.execution.runId) {
      return { ...parsed, delivered: true };
    }
    return parsed;
  }
  return null;
}
