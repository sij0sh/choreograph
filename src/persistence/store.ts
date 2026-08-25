import { SNAPSHOT_TYPE, parseSnapshot, type ParsedSnapshot } from "./snapshot.ts";

export class WorkflowStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`workflow ${operation} was not committed to session storage: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowStorageError";
  }
}

export interface SnapshotStore {
  append(snapshot: unknown): void;
}

export function commitSnapshot(store: SnapshotStore, snapshot: unknown, operation: string): void {
  try {
    store.append(snapshot);
  } catch (cause) {
    throw new WorkflowStorageError(operation, cause);
  }
}

export function latestSnapshot(branch: readonly unknown[]): ParsedSnapshot | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) return parseSnapshot(entry.data);
  }
  return null;
}
