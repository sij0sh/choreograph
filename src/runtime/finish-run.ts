import { frameAttempt, isAttemptBearingFrame, upsertInvocation, type Run } from "../domain/run.ts";
import { runnerOfLeaf } from "../engine/interpreter.ts";
import { LIMITS } from "../domain/limits.ts";
import { terminalSnapshot } from "../persistence/snapshot.ts";
import { SnapshotByteBudgetReached, SnapshotCapReached, WorkflowStorageError } from "../persistence/store.ts";
import { renderReportEnvelope, summaryMessage } from "./prompts.ts";
import type { ActiveState, ToolResult, UiContext } from "./types.ts";
import { assertNotCancelled, type CoordinatorInternals } from "./internal.ts";
import { byteCapPhraseLower, byteStay, capStay, storageFailed, type FailureIdentity } from "./commit-failures.ts";

/**
 * Stop the run in memory when a terminal commit fails (C10). A user-visible
 * failed abort must leave nothing dispatchable: the in-memory run goes idle
 * even though the terminal record failed to persist.
 */
function stopLocalRun(c: CoordinatorInternals, run: ActiveState, ctx: UiContext): void {
  c.state = { status: "idle" };
  c.lastTerminal = "aborted";
  c.releaseArtifacts(run.execution.runId);
  c.setTools();
  c.showStatus(ctx);
}

export async function runAbort(c: CoordinatorInternals, signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
  const current = c.requireAbortable();
  assertNotCancelled(signal);
  await c.registry.cancelAll();
  // corr-c8: the terminal commit is serialized against the transition
  // epilogue; the re-check under the lock keeps a completed run from being
  // retro-aborted when a concurrent transition lands first.
  return c.runTerminalExclusive(signal, async () => {
    if (c.state.status !== "active" && c.state.status !== "paused") {
      return {
        content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} is no longer active; there is nothing to abort.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "not-active" },
      };
    }
    const active = c.state;
    const leaf = active.execution.stack[active.execution.stack.length - 1];
    const execution = leaf && isAttemptBearingFrame(leaf)
      ? { ...active.execution, status: "aborted" as const, invocations: upsertInvocation(active.execution, leaf.key, {
          blockId: leaf.blockId,
          key: leaf.key,
          runner: runnerOfLeaf(active.workflow, leaf),
          status: "canceled",
          attempt: frameAttempt(leaf),
        }) }
      : { ...active.execution, status: "aborted" as const };
    return finishRun(c, active, ctx, "aborted", execution);
  });
}

export async function finishRun(c: CoordinatorInternals, current: ActiveState, ctx: UiContext, status: "completed" | "aborted", final: Run): Promise<ToolResult> {
  if (status === "completed" && c.supportsSessionRollover(ctx)) {
    try {
      c.prepareRollover(current.workflow, final, terminalSnapshot(status, current.workflow.name, current.execution.runId, final), true, ctx);
    } catch (error) {
      return {
        content: [{ type: "text", text: `The run completed but its bounded report session could not be prepared: ${error instanceof Error ? error.message : String(error)}. Retry the transition or abort the run.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-failed" },
        isError: true,
        terminate: true,
      };
    }
    c.lastTerminal = status;
    c.releaseArtifacts(current.execution.runId);
    return {
      content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} completed. Its final report will run in a fresh bounded session.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-pending" },
      terminate: true,
    };
  }
  const identity: FailureIdentity = { workflow: current.workflow.name, runId: current.execution.runId };
  try {
    c.commit(terminalSnapshot(status, current.workflow.name, current.execution.runId, final), `${status === "completed" ? "completion" : "abort"} of ${current.workflow.title} run ${current.execution.runId}`);
  } catch (error) {
    const stopped = status === "aborted";
    if (error instanceof SnapshotCapReached) {
      if (stopped) stopLocalRun(c, current, ctx);
      return capStay(identity, stopped
        ? `The run was aborted, but the session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so the terminal record was not committed. The run is stopped locally and the abort is not persisted.`
        : `The run ${status}, but the session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so its terminal record was not committed. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.`);
    }
    if (error instanceof SnapshotByteBudgetReached) {
      if (stopped) stopLocalRun(c, current, ctx);
      return byteStay(identity, stopped
        ? `The run was aborted, but ${byteCapPhraseLower(error)} (LIMITS.snapshotBytesPerSession), so the terminal record was not committed. The run is stopped locally and the abort is not persisted.`
        : `The run ${status}, but ${byteCapPhraseLower(error)} (LIMITS.snapshotBytesPerSession), so its terminal record was not committed. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.`, error);
    }
    if (!(error instanceof WorkflowStorageError)) throw error;
    if (stopped) stopLocalRun(c, current, ctx);
    return storageFailed(identity, stopped
      ? `${error.message}. The run was aborted and is stopped locally, but its terminal record failed to persist.`
      : `${error.message}. The run stays active at ${current.execution.stack.at(-1)?.key}.`);
  }
  c.state = { status: "idle" };
  c.lastTerminal = status;
  // Terminal release (fx3): the run is over; a later store for this runId simply
  // re-creates one for the same dir, and content addressing makes that harmless.
  // Mid-run rollovers keep the entry - only terminal run states release it.
  c.releaseArtifacts(current.execution.runId);
  c.setTools();
  c.showStatus(ctx);
  if (status === "completed") {
    try {
      await c.pi.sendUserMessage(`${summaryMessage(current.workflow, final)}\n\n${renderReportEnvelope(current.workflow, final, c.frozen.promptRead)}`, { deliverAs: "followUp" });
    } catch (error) {
      ctx.ui.notify(`Workflow summary request failed: ${error instanceof Error ? error.message : String(error)}.`, "error");
    }
    return {
      content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} completed. A summary request arrives in the next message.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
      terminate: true,
    };
  }
  return {
    content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} aborted.` }],
    details: { workflow: current.workflow.name, runId: current.execution.runId, status: "aborted" },
    terminate: true,
  };
}
