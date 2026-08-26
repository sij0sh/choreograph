import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import { SNAPSHOT_TYPE, parseSnapshot, type ActiveSnapshotV5, type ParsedSnapshot } from "./snapshot.ts";

export class WorkflowStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`workflow ${operation} was not committed to session storage: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowStorageError";
  }
}

export interface SnapshotStore {
  append(snapshot: unknown): void;
}

export function withinMemoryBound(snapshot: ActiveSnapshotV5): boolean {
  const bytes = canonicalJsonBytes({
    checkpoints: snapshot.execution.checkpoints,
    checkpointOrder: snapshot.execution.checkpointOrder,
    plans: snapshot.execution.plans,
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
