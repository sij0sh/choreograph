import { LIMITS } from "../domain/limits.ts";
import { transition as engineTransition, type TaskOutcome } from "../engine/interpreter.ts";
import { activeSnapshot } from "../persistence/snapshot.ts";
import { withinMemoryBound, SnapshotByteBudgetReached, SnapshotCapReached, WorkflowStorageError } from "../persistence/store.ts";
import type { ActiveState, ToolResult, UiContext } from "./types.ts";
import { assertNotCancelled, type CoordinatorInternals } from "./internal.ts";
import { byteCapPhrase, capStay, driveFailure, rolloverPending, storageFailed, byteStay, type FailureIdentity } from "./commit-failures.ts";

/** Truthful response when the run ended while this operation was in flight (corr-c8). */
function runEndedText(c: CoordinatorInternals, run: ActiveState): ToolResult {
  const ended = c.lastTerminal === "completed" ? "completed" : "was aborted";
  return {
    content: [{ type: "text", text: `${run.workflow.title} run ${run.execution.runId} ${ended} while this operation was in flight. The run is over; no further instructions or deliveries will arrive.` }],
    details: { workflow: run.workflow.name, runId: run.execution.runId, status: c.lastTerminal === "completed" ? "completed" : "aborted" },
    terminate: true,
  };
}

/**
 * Post-drive epilogue (corr-c8): the response describes the run state after
 * this transition's own effects, sampled under the terminal lock so a
 * concurrent abort can never interleave between the sample and the text.
 */
function transitionEpilogue(c: CoordinatorInternals, current: ActiveState, outcome: TaskOutcome, rollover: boolean, effectKind: "complete" | "advance" | "stay", ctx: UiContext): ToolResult {
  if (c.state.status === "paused") {
    return {
      content: [{ type: "text", text: `Recorded ${outcome.status}. The run is paused at ${c.state.execution.stack.at(-1)?.key}; see the pause notice above. Abort the run or address the pause cause, then resume.` }],
      details: { workflow: c.state.workflow.name, runId: c.state.execution.runId, position: c.state.execution.stack.at(-1)?.key, status: "paused" },
    };
  }
  if (c.state.status !== "active") {
    if (c.lastTerminal === "aborted") return runEndedText(c, current);
    return {
      content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} completed during script execution. Its bounded summary session is being prepared.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
      terminate: true,
    };
  }
  if (rollover) {
    const active = c.state;
    c.prepareRollover(active.workflow, active.execution, c.snapshotOf(active, false), false, ctx);
    return {
      content: [{ type: "text", text: `Recorded ${outcome.status}. The workflow continues at ${active.execution.stack.at(-1)?.key} in a fresh session.` }],
      details: { workflow: active.workflow.name, runId: active.execution.runId, position: active.execution.stack.at(-1)?.key, status: "rollover-pending" },
      terminate: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          effectKind === "stay"
            ? `Recorded ${outcome.status}. The run stays at ${c.state.execution.stack.at(-1)?.key}${outcome.status === "blocked" ? " and waits for the user" : ""}; the checkpoint is saved.`
            : `Recorded ${outcome.status}. Continue at ${c.state.execution.stack.at(-1)?.key}; instructions arrive in the next message.`,
      },
    ],
    details: { workflow: c.state.workflow.name, runId: c.state.execution.runId, position: c.state.execution.stack.at(-1)?.key, status: outcome.status === "blocked" ? "blocked" : "active" },
  };
}

export async function runTransition(c: CoordinatorInternals, params: unknown, signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
  const current = c.requireActive();
  assertNotCancelled(signal);
  if (!current.delivered) {
    return {
      content: [{ type: "text", text: `Cannot transition \`${current.execution.stack.at(-1)?.key}\` before its instructions are delivered. They arrive as the next message; finish the current reply first.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "delivery-pending" },
      isError: true,
    };
  }
  const outcome = params as TaskOutcome;
  const result = engineTransition(current.workflow, current.execution, { type: "outcome", outcome }, c.artifactStoreFor(current.workflow, current.execution.runId));
  if (!result.ok) {
    return {
      content: [{ type: "text", text: `Invalid transition: ${result.error}.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "invalid-transition" },
      isError: true,
    };
  }
  // Engine-accepted transition: this run concluded its position, so the settle
  // guard must not nudge, and the stall episode resets (see settle-guard.ts).
  c.transitionSeen = true;
  c.stallCount = 0;
  c.stalledNotified = false;
  if (result.effect.kind === "complete") {
    return c.runTerminalExclusive(signal, async () => {
      if (c.state.status !== "active") return runEndedText(c, current);
      c.settleAgent(current, outcome);
      return c.finishRun(current, ctx, "completed", result.state);
    });
  }
  // A blocked position waits for the user in this session; rolling it over would respawn the same blocker forever.
  const rollover = c.supportsSessionRollover(ctx) && outcome.status !== "blocked";
  const next: ActiveState = { ...current, execution: result.state, delivered: rollover ? false : result.effect.kind === "stay" };
  const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: next.delivered });
  if (!withinMemoryBound(pendingSnapshot)) {
    return {
      content: [{ type: "text", text: `The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB; the transition was rejected. Abort the run or narrow the checkpoint data.` }],
      details: { workflow: current.workflow.name, runId: current.execution.runId, status: "memory-bound" },
      isError: true,
    };
  }
  c.settleAgent(current, outcome);
  const identity: FailureIdentity = { workflow: current.workflow.name, runId: current.execution.runId };
  try {
    c.commit(c.snapshotOf(next, next.delivered), `transition of ${current.workflow.title} run ${current.execution.runId} to ${result.state.stack.at(-1)?.key ?? "completion"}`);
  } catch (error) {
    const nextKey = next.execution.stack.at(-1)?.key;
    const currentKey = current.execution.stack.at(-1)?.key;
    if (error instanceof SnapshotCapReached) {
      if (c.supportsSessionRollover(ctx)) {
        c.prepareRollover(current.workflow, next.execution, pendingSnapshot, false, ctx);
        return rolloverPending({ ...identity, position: nextKey }, `Recorded ${outcome.status}. The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap; the workflow continues at ${nextKey} in a fresh session.`);
      }
      return capStay({ ...identity, position: currentKey }, `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so the transition was not committed. The run stays at ${currentKey}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.`);
    }
    if (error instanceof SnapshotByteBudgetReached) {
      if (c.supportsSessionRollover(ctx)) {
        c.prepareRollover(current.workflow, next.execution, pendingSnapshot, false, ctx);
        return rolloverPending({ ...identity, position: nextKey }, `Recorded ${outcome.status}. ${byteCapPhrase(error)}; the workflow continues at ${nextKey} in a fresh session.`);
      }
      return byteStay({ ...identity, position: currentKey }, `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession), so the transition was not committed. The run stays at ${currentKey}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.`, error);
    }
    if (!(error instanceof WorkflowStorageError)) throw error;
    return storageFailed(identity, `${error.message}. The run stays at ${currentKey}.`);
  }
  c.adoptActive(next, ctx);
  c.suppressDelivery = rollover;
  try {
    await c.drive(next, ctx);
  } catch (error) {
    return driveFailure(c, error, ctx, identity, next, current.execution.stack.at(-1)?.key);
  } finally {
    c.suppressDelivery = false;
  }
  return c.runTerminalExclusive(signal, () => Promise.resolve(transitionEpilogue(c, current, outcome, rollover, result.effect.kind === "stay" ? "stay" : "advance", ctx)));
}
