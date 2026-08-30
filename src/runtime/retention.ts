import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { LIMITS } from "../domain/limits.ts";
import type { Workflow } from "../domain/workflow.ts";

export interface SweepOutcome {
  readonly evicted: readonly string[];
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

/**
 * Evicts the oldest run directories beyond the retention policy
 * (LIMITS.runArtifactsKeepRuns / LIMITS.runArtifactsKeepBytes). Oldest-first by
 * mtime; the active run is never evicted. Best effort: the pass stops at the
 * first deletion failure and reports it.
 */
export function sweepRunArtifacts(runsDir: string, activeRunId: string | undefined): SweepOutcome {
  const evicted: string[] = [];
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
    return { evicted };
  }
  let count = entries.length;
  let total = 0;
  for (const item of entries) total += item.bytes;
  for (const item of entries) {
    if (count <= LIMITS.runArtifactsKeepRuns && total <= LIMITS.runArtifactsKeepBytes) break;
    if (item.name === activeRunId) continue;
    try {
      rmSync(join(runsDir, item.name), { recursive: true, force: true });
    } catch (error) {
      return { evicted, error: error instanceof Error ? error.message : String(error) };
    }
    count -= 1;
    total -= item.bytes;
    evicted.push(item.name);
  }
  return { evicted };
}

/** The workflow directory that roots `.choreograph/`, or the runtime fallback. */
export function workflowArtifactRoot(workflow: Workflow, fallback: string | undefined): string | undefined {
  const workflowDir = dirname(workflow.overviewPath);
  return isAbsolute(workflowDir) && existsSync(workflowDir) ? workflowDir : fallback;
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
    } catch (error) {
      notify(`Artifact retention sweep failed: ${error instanceof Error ? error.message : String(error)}. Continuing.`, "warning");
    }
  }
}
