import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import type { ActiveSnapshotV4, TerminalSnapshot } from "./snapshot.ts";

export function encodeSnapshot(snapshot: ActiveSnapshotV4 | TerminalSnapshot): string {
  return JSON.stringify(snapshot);
}

export function memoryBytesOf(snapshot: ActiveSnapshotV4): number {
  return canonicalJsonBytes({
    checkpoints: snapshot.execution.checkpoints,
    plans: snapshot.execution.plans,
  } as unknown as JsonValue);
}

export function withinMemoryBound(snapshot: ActiveSnapshotV4): boolean {
  return memoryBytesOf(snapshot) <= LIMITS.memoryBytes;
}

export function decodeSnapshot(text: string): unknown {
  return JSON.parse(text);
}
