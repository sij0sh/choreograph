import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import { SNAPSHOT_TYPE, parseSnapshot, type ActiveSnapshotV7, type ParsedSnapshot } from "./snapshot.ts";

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

/** Counts choreograph snapshot entries in a session branch (cheap counter input). */
export function countSnapshotEntries(branch: readonly unknown[]): number {
  let count = 0;
  for (const entry of branch) {
    const item = entry as { type?: unknown; customType?: unknown };
    if (item.type === "custom" && item.customType === SNAPSHOT_TYPE) count += 1;
  }
  return count;
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

export function latestSnapshot(branch: readonly unknown[]): ParsedSnapshot | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) return parseSnapshot(entry.data);
  }
  return null;
}
