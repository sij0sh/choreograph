import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LIMITS } from "../domain/limits.ts";
import { runMarkerState } from "./run-marker.ts";
import { workflowBlocks, scriptCwdOf, type Workflow } from "../domain/workflow.ts";

export interface SweepOutcome {
  readonly evicted: readonly string[];
  /** Run dirs skipped because their active-run marker is stale (crash orphan); kept for manual reclaim. */
  readonly staleMarkers: readonly string[];
  readonly error?: string;
}

export interface MaterializeSweepOutcome {
  readonly evicted: readonly string[];
  readonly evictedBytes: number;
  readonly error?: string;
}

function dirBytes(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    bytes += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
  }
  return bytes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Evicts the oldest run directories beyond the retention policy
 * (LIMITS.runArtifactsKeepRuns / LIMITS.runArtifactsKeepBytes). Oldest-first by
 * mtime; the active run is never evicted. Best effort: the pass stops at the
 * first deletion failure and reports it.
 */
export function sweepRunArtifacts(runsDir: string, activeRunId: string | undefined): SweepOutcome {
  const evicted: string[] = [];
  const staleMarkers: string[] = [];
  let entries: { name: string; mtimeMs: number; bytes: number }[];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => ({
        name: item.name,
        mtimeMs: statSync(join(runsDir, item.name)).mtimeMs,
        bytes: dirBytes(join(runsDir, item.name)),
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    // No runs dir yet, or unreadable: nothing to reclaim on this pass.
    return { evicted, staleMarkers };
  }
  // A live run dir may outlive this session's name match (another session, a
  // crashed-and-restored run), so markers, not names, decide evictability.
  const marked = new Set<string>();
  for (const item of entries) {
    if (item.name === activeRunId) continue;
    const marker = runMarkerState(join(runsDir, item.name));
    if (!marker.present) continue;
    marked.add(item.name);
    if (marker.stale) staleMarkers.push(item.name);
  }
  let count = entries.length;
  let total = 0;
  for (const item of entries) total += item.bytes;
  for (const item of entries) {
    if (count <= LIMITS.runArtifactsKeepRuns && total <= LIMITS.runArtifactsKeepBytes) break;
    if (item.name === activeRunId || marked.has(item.name)) continue;
    try {
      rmSync(join(runsDir, item.name), { recursive: true, force: true });
    } catch (error) {
      return { evicted, staleMarkers, error: messageOf(error) };
    }
    count -= 1;
    total -= item.bytes;
    evicted.push(item.name);
  }
  return { evicted, staleMarkers };
}

/**
 * Evicts the oldest materialized artifact copies beyond keepBytes
 * (LIMITS.materializeKeepBytes). Oldest-first by mtime; copies written within
 * the mtime grace window are never evicted, because a script dispatched with
 * the copy as input may still be reading it. Evicted copies re-materialize on
 * demand (content-addressed rewrite), so eviction costs one rewrite, never
 * correctness. Best effort: a missing directory sweeps nothing, ENOENT unlink
 * races between concurrent sessions are ignored, and the pass stops at the
 * first other deletion failure and reports it.
 */
export function sweepMaterializedArtifacts(
  artifactsDir: string,
  keepBytes: number = LIMITS.materializeKeepBytes,
  graceMs: number = LIMITS.materializeGraceMs,
  now: number = Date.now(),
): MaterializeSweepOutcome {
  const evicted: string[] = [];
  let evictedBytes = 0;
  const entries: { name: string; mtimeMs: number; bytes: number }[] = [];
  try {
    for (const item of readdirSync(artifactsDir, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      try {
        const stat = statSync(join(artifactsDir, item.name));
        // Floor to whole milliseconds: Date.now()-based ages must see a just
        // written copy as age >= 0, or a zero grace would never evict it.
        entries.push({ name: item.name, mtimeMs: Math.floor(stat.mtimeMs), bytes: stat.size });
      } catch {
        // Vanished between readdir and stat (concurrent session): nothing to reclaim.
      }
    }
  } catch (error) {
    if (isEnoent(error)) return { evicted, evictedBytes };
    return { evicted, evictedBytes, error: messageOf(error) };
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = 0;
  for (const entry of entries) total += entry.bytes;
  for (const entry of entries) {
    if (now - entry.mtimeMs < graceMs) continue;
    if (total <= keepBytes) break;
    try {
      rmSync(join(artifactsDir, entry.name), { force: true });
    } catch (error) {
      return { evicted, evictedBytes, error: messageOf(error) };
    }
    total -= entry.bytes;
    evictedBytes += entry.bytes;
    evicted.push(entry.name);
  }
  return { evicted, evictedBytes };
}

/** The workflow directory that roots `.choreograph/`, or the runtime fallback. */
export function workflowArtifactRoot(workflow: Workflow, fallback: string | undefined): string | undefined {
  const workflowDir = dirname(workflow.overviewPath);
  return isAbsolute(workflowDir) && existsSync(workflowDir) ? workflowDir : fallback;
}

/**
 * The materialize roots for a workflow: the workflow root plus each script
 * block cwd resolved against the workflow directory (authoring keeps script
 * cwds inside the workflow directory).
 */
function materializeDirs(workflow: Workflow, root: string): readonly string[] {
  const dirs = new Set<string>([join(root, ".choreograph", "artifacts")]);
  const workflowDir = dirname(workflow.overviewPath);
  if (!isAbsolute(workflowDir)) return [...dirs];
  for (const block of workflowBlocks(workflow)) {
    const cwd = scriptCwdOf(block);
    if (cwd) dirs.add(join(resolve(workflowDir, cwd), ".choreograph", "artifacts"));
  }
  return [...dirs];
}

/** Best-effort retention sweep at session/run start; announces evictions and failures. */
export function sweepWorkflowArtifacts(
  workflows: readonly Workflow[],
  fallbackRoot: string | undefined,
  activeRunId: string | undefined,
  notify: (message: string, level: "info" | "error" | "warning") => void,
  only?: Workflow,
): void {
  for (const workflow of only ? [only] : workflows) {
    const root = workflowArtifactRoot(workflow, fallbackRoot);
    if (!root) continue;
    try {
      const outcome = sweepRunArtifacts(join(root, ".choreograph", "runs"), activeRunId);
      if (outcome.evicted.length) notify(`Artifact retention pruned ${outcome.evicted.length} old run(s): ${outcome.evicted.join(", ")}.`, "info");
      if (outcome.error) notify(`Artifact retention sweep stopped early: ${outcome.error}.`, "warning");
      if (outcome.staleMarkers.length) notify(`Artifact retention kept ${outcome.staleMarkers.length} run dir(s) with stale active-run marker(s): ${outcome.staleMarkers.join(", ")}. Their runs likely crashed; reclaim manually by deleting the run dir under ${join(root, ".choreograph", "runs")}.`, "warning");
    } catch (error) {
      notify(`Artifact retention sweep failed: ${messageOf(error)}. Continuing.`, "warning");
    }
    for (const dir of materializeDirs(workflow, root)) {
      try {
        const outcome = sweepMaterializedArtifacts(dir);
        if (outcome.evicted.length) notify(`Artifact retention pruned ${outcome.evicted.length} materialized artifact copy(ies) (${outcome.evictedBytes} bytes) from ${dir}.`, "info");
        if (outcome.error) notify(`Artifact retention sweep stopped early in ${dir}: ${outcome.error}.`, "warning");
      } catch (error) {
        notify(`Artifact retention sweep failed: ${messageOf(error)}. Continuing.`, "warning");
      }
    }
  }
}
