import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "../domain/limits.ts";

/**
 * Liveness marker for a run directory. The retention sweep defines "active"
 * per-session while run directories are shared across sessions, so the name
 * match alone can evict another live session's run. A marker file written at
 * run start and cleared on every terminal release lets the sweep skip any
 * directory that some process still claims. Markers orphaned by a crash are
 * reported (not auto-evicted): the operator reclaims them manually.
 */
export const RUN_MARKER_NAME = ".active";

/** The marker file path inside a run directory. */
export function runMarkerPath(runDir: string): string {
  return join(runDir, RUN_MARKER_NAME);
}

/** Marks a run directory live; best effort (a failed write costs a sweep warning, not the run). */
export function writeRunMarker(runDir: string, runId: string): void {
  try {
    mkdirSync(runDir, { recursive: true });
    const payload = `${JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() })}\n`;
    writeFileSync(runMarkerPath(runDir), payload);
  } catch {
    // Observability must not turn a marker failure into a run failure.
  }
}

/** Clears the marker on a terminal release; best effort. */
export function clearRunMarker(runDir: string): void {
  try {
    rmSync(runMarkerPath(runDir), { force: true });
  } catch {
    // A stale marker only costs a sweep warning.
  }
}

/** Whether the directory currently bears a marker. */
export function hasRunMarker(runDir: string): boolean {
  try {
    statSync(runMarkerPath(runDir));
    return true;
  } catch {
    return false;
  }
}

/** Marker presence plus staleness (older than LIMITS.activeMarkerGraceMs). */
export function runMarkerState(runDir: string, now: number = Date.now()): { present: boolean; stale: boolean } {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(runMarkerPath(runDir)).mtimeMs;
  } catch {
    return { present: false, stale: false };
  }
  return { present: true, stale: now - mtimeMs > LIMITS.activeMarkerGraceMs };
}
