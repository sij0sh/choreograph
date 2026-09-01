import { LIMITS } from "../domain/limits.ts";
import type { ActiveState, ToolResult, UiContext } from "./types.ts";
import { assertNotCancelled, type CoordinatorInternals } from "./internal.ts";
import { byteCapPhrase, byteStay, capStay, driveFailure, rolloverPending, storageFailed, type FailureIdentity } from "./commit-failures.ts";
import { SnapshotByteBudgetReached, SnapshotCapReached, WorkflowStorageError } from "../persistence/store.ts";

export async function retryRun(c: CoordinatorInternals, signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
  const current = c.requireActive();
  assertNotCancelled(signal);
  const rollover = c.supportsSessionRollover(ctx);
  const leafKeyNow = current.execution.stack.at(-1)?.key;
  const runtimeExecuted = c.registry.executesCurrentLeaf(current.workflow, current.execution);
  const parked = leafKeyNow !== undefined && current.execution.invocations?.[leafKeyNow]?.status === "waiting";
  if (!runtimeExecuted || !parked) {
    return {
      content: [{ type: "text", text: `workflow_retry applies only when the run is parked at a failed runtime-executed step; the run is at ${current.execution.stack.at(-1)?.key}.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, position: current.execution.stack.at(-1)?.key, status: "not-script" },
      isError: true,
    };
  }
  const next: ActiveState = { ...current, delivered: false };
  const identity: FailureIdentity = { workflow: current.workflow.name, runId: current.execution.runId };
  try {
    c.commit(c.snapshotOf(next, false), `retry of process ${leafKeyNow} in ${current.workflow.title} run ${current.execution.runId}`);
  } catch (error) {
    if (error instanceof SnapshotCapReached) {
      if (rollover) {
        c.prepareRollover(current.workflow, current.execution, c.snapshotOf(current, false), false, ctx);
        return rolloverPending({ ...identity, position: current.execution.stack.at(-1)?.key }, `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap; the run continues in a fresh session, where you can retry process ${leafKeyNow}.`);
      }
      return capStay({ ...identity, position: leafKeyNow }, `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so the retry was not recorded. The run stays parked at ${leafKeyNow}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.`);
    }
    if (error instanceof SnapshotByteBudgetReached) {
      if (rollover) {
        c.prepareRollover(current.workflow, current.execution, c.snapshotOf(current, false), false, ctx);
        return rolloverPending({ ...identity, position: current.execution.stack.at(-1)?.key }, `${byteCapPhrase(error)}; the run continues in a fresh session, where you can retry process ${leafKeyNow}.`);
      }
      return byteStay({ ...identity, position: leafKeyNow }, `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession), so the retry was not recorded. The run stays parked at ${leafKeyNow}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.`, error);
    }
    if (!(error instanceof WorkflowStorageError)) throw error;
    return storageFailed(identity, `${error.message}. The run stays parked at ${leafKeyNow}.`);
  }
  c.adoptActive(next, ctx);
  c.suppressDelivery = rollover;
  try {
    await c.drive(next, ctx, true);
  } catch (error) {
    return driveFailure(c, error, ctx, identity, current, leafKeyNow);
  } finally {
    c.suppressDelivery = false;
  }
  if (c.state.status === "paused") {
    return {
      content: [{ type: "text", text: `Retried process ${leafKeyNow}; the run is paused at ${c.state.execution.stack.at(-1)?.key}. Abort the run or narrow the workflow outputs.` }],
      details: { workflow: c.state.workflow.name, runId: c.state.execution.runId, position: c.state.execution.stack.at(-1)?.key, status: "paused" },
    };
  }
  if (c.state.status !== "active") {
    return {
      content: [{ type: "text", text: `Retried process ${leafKeyNow}; ${current.workflow.title} run ${current.execution.runId} completed. A summary request arrives in the next message.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
      terminate: true,
    };
  }
  const leafKey = c.state.execution.stack.at(-1)?.key;
  if (rollover) {
    const active = c.state;
    c.prepareRollover(active.workflow, active.execution, c.snapshotOf(active, false), false, ctx);
    return rolloverPending({ workflow: active.workflow.name, runId: active.execution.runId, position: leafKey }, `Retried process ${leafKeyNow}. The workflow will continue at ${leafKey} in a fresh session.`);
  }
  const parkedNow = leafKey !== undefined && c.state.execution.invocations?.[leafKey]?.status === "waiting";
  const failureSummary = parkedNow && leafKey !== undefined ? c.state.execution.checkpoints[leafKey]?.summary : undefined;
  return {
    content: [{ type: "text", text: parkedNow
      ? `Retried process ${leafKeyNow}; it failed again: ${failureSummary ?? "see the checkpoint"}. The run stays parked at ${leafKey}. Fix the cause, call workflow_retry again, or workflow_abort.`
      : `Retried process ${leafKeyNow}. The run stopped at ${leafKey}.` }],
    details: { workflow: c.state.workflow.name, runId: c.state.execution.runId, position: leafKey, status: parkedNow ? "parked" : "active" },
  };
}
