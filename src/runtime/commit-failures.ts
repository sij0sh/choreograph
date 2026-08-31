import { LIMITS } from "../domain/limits.ts";
import { SnapshotByteBudgetReached, SnapshotCapReached } from "../persistence/store.ts";
import type { ActiveState, ToolResult, UiContext } from "./types.ts";
import type { CoordinatorInternals } from "./internal.ts";

export type FailureIdentity = { workflow: string; runId: string };

/** Byte-cap wording shared by every snapshot-byte pause and rollover message (fx5a). */
export const byteCapPhrase = (error: SnapshotByteBudgetReached): string =>
  `The session's snapshot log reached ${error.bytes} of ${error.budget} bytes`;
export const byteCapPhraseLower = (error: SnapshotByteBudgetReached): string =>
  `the session's snapshot log reached ${error.bytes} of ${error.budget} bytes`;

const text = (message: string) => [{ type: "text" as const, text: message }];

/** The recorded step continues in a fresh session. */
export function rolloverPending(details: Record<string, unknown>, message: string): ToolResult {
  return { content: text(message), details: { ...details, status: "rollover-pending" }, terminate: true };
}

/** The session hit its snapshot-entry cap; the step was not committed. */
export function capStay(details: Record<string, unknown>, message: string): ToolResult {
  return { content: text(message), details: { ...details, status: "snapshot-cap" }, isError: true };
}

/** The session hit its snapshot-byte budget; the step was not committed. */
export function byteStay(details: Record<string, unknown>, message: string, error: SnapshotByteBudgetReached): ToolResult {
  return {
    content: text(message),
    details: { ...details, status: "snapshot-byte-cap", snapshotBytes: error.bytes, snapshotBytesBudget: error.budget },
    isError: true,
  };
}

/** The commit failed for a storage reason. */
export function storageFailed(details: Record<string, unknown>, message: string): ToolResult {
  return { content: text(message), details: { ...details, status: "storage-failed" }, isError: true };
}

/**
 * Handle a failure thrown out of script execution: a rollover-capable host
 * continues in a fresh session, an embedded host pauses the run where it is.
 * Anything that is neither a snapshot cap nor a byte budget rethrows.
 */
export function driveFailure(c: CoordinatorInternals, error: unknown, ctx: UiContext, identity: FailureIdentity, resume: ActiveState, fallbackPosition: string | undefined): ToolResult {
  const active = c.state.status === "active" ? c.state : resume;
  const position = c.state.status === "active" ? c.state.execution.stack.at(-1)?.key : fallbackPosition;
  if (error instanceof SnapshotCapReached) {
    if (c.supportsSessionRollover(ctx)) {
      c.prepareRollover(resume.workflow, active.execution, c.snapshotOf(active, false), false, ctx);
      return rolloverPending(identity, `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap during script execution; the workflow continues in a fresh session.`);
    }
    return capStay(identity, `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap during script execution; the run is paused at ${position}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.`);
  }
  if (error instanceof SnapshotByteBudgetReached) {
    if (c.supportsSessionRollover(ctx)) {
      c.prepareRollover(resume.workflow, active.execution, c.snapshotOf(active, false), false, ctx);
      return rolloverPending(identity, `${byteCapPhrase(error)} during script execution; the workflow continues in a fresh session.`);
    }
    return byteStay(identity, `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession) during script execution; the run is paused at ${position}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.`, error);
  }
  throw error;
}
