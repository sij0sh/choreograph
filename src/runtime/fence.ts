import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FENCE_DIR = ".choreograph/fences";

export interface FenceRecord {
  readonly pid: number;
  readonly attempt: number;
  readonly startedAt: number;
}

export type FenceState =
  | { readonly status: "absent" }
  | { readonly status: "alive"; readonly pid: number; readonly path: string }
  | { readonly status: "dead"; readonly pid: number; readonly path: string };

/**
 * Deterministic per-invocation fence path under the shared script workspace.
 * Invocation keys may contain path-hostile characters, so they are sanitized
 * and disambiguated with a short digest of the raw key.
 */
export function fencePath(scriptCwd: string, invocationKey: string): string {
  const safe = invocationKey.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(invocationKey).digest("hex").slice(0, 16);
  return join(scriptCwd, FENCE_DIR, `${safe}-${digest}.json`);
}

/**
 * Classifies the process recorded in a fence: alive via kill(pid, 0). A pid
 * reused by an unrelated process reads as alive, which parks the run instead
 * of double-dispatching - the safe direction; workflow_retry resolves it.
 */
export function consultFence(scriptCwd: string, invocationKey: string): FenceState {
  const path = fencePath(scriptCwd, invocationKey);
  let pid: number;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FenceRecord>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return { status: "absent" };
    pid = parsed.pid;
  } catch {
    return { status: "absent" };
  }
  try {
    process.kill(pid, 0);
    return { status: "alive", pid, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return { status: "alive", pid, path };
    return { status: "dead", pid, path };
  }
}

/**
 * Writes the fence atomically (temp + rename). Throws so the dispatcher can
 * fail closed: no script runs without its fence.
 */
export function writeFence(scriptCwd: string, invocationKey: string, pid: number, attempt: number): string {
  const path = fencePath(scriptCwd, invocationKey);
  mkdirSync(dirname(path), { recursive: true });
  const record: FenceRecord = { pid, attempt, startedAt: Date.now() };
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
  renameSync(temp, path);
  return path;
}

/** Best-effort removal; a stale fence is inert because only recorded-"running" leaves consult it. */
export function removeFence(scriptCwd: string, invocationKey: string): void {
  try {
    rmSync(fencePath(scriptCwd, invocationKey), { force: true });
  } catch {
    // Inert either way.
  }
}
