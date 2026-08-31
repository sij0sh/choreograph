import { frameAttempt, isAgentDispatchFrame } from "../domain/execution.ts";
import { processLeafAt } from "../engine/interpreter.ts";
import { LIMITS } from "../domain/limits.ts";
import { controlMessage } from "./prompts.ts";
import type { ActiveState, UiContext } from "./types.ts";
import type { CoordinatorInternals } from "./internal.ts";

/**
 * Settle guard: an agent position settles only on a transition or an abort
 * (the runner contract). A reply that ends without either - the transition
 * written as text, a truncated or empty reply - would stall the run silently,
 * because the position's message was already delivered and delivery-side
 * recovery never fires. Nudge the model back to the `workflow_transition`
 * tool call, at most LIMITS.settleNudges times per episode, then stop and
 * tell the user the run is stalled.
 *
 * The guard only fires when the settled run actually started (agent_start)
 * and made no engine-accepted transition: a settle that follows a healthy
 * advance must not double-message, and a settle with delivery still pending
 * belongs to the delivery-retry path.
 */
export async function guardSettled(c: CoordinatorInternals, ctx: UiContext): Promise<void> {
  const active: ActiveState | undefined = c.state.status === "active" ? c.state : undefined;
  const ran = c.agentRunStarted;
  const transitioned = c.transitionSeen;
  c.transitionSeen = false;
  if (!active || !ran || transitioned) {
    c.agentRunStarted = false;
    return;
  }
  const leaf = active.execution.stack[active.execution.stack.length - 1];
  const stalled = Boolean(
    leaf
    && isAgentDispatchFrame(leaf)
    && active.delivered
    && !processLeafAt(active.workflow, active.execution),
  );
  if (!stalled) {
    c.agentRunStarted = false;
    return;
  }
  if (c.stallCount >= LIMITS.settleNudges) {
    c.agentRunStarted = false;
    if (!c.stalledNotified) {
      c.stalledNotified = true;
      ctx.ui.notify(
        `Workflow ${active.workflow.title} run ${active.execution.runId} stalled at \`${leaf.key}\`: ${LIMITS.settleNudges} replies ended without a \`workflow_transition\` call. Send the agent a message to unstick it, or abort the run.`,
        "error",
      );
    }
    return;
  }
  const message = [
    controlMessage(active.execution),
    "",
    "Your last reply ended without a `workflow_transition` tool call, so nothing was recorded.",
    "A transition written as text (including `<workflow_transition>` blocks) is not executed.",
    "Call the `workflow_transition` tool now with the exact shape from the transition contract; copy `key` verbatim from the `Position` line of the instructions envelope.",
  ].join("\n");
  const delivered = await c.delivery.deliver({
    runId: active.execution.runId,
    key: `${leaf.key}#attempt-${frameAttempt(leaf)}#nudge-${c.nudgeSeq + 1}`,
    message,
    isLive: () => c.state === active,
  });
  if (delivered && c.state === active) {
    c.stallCount += 1;
    c.nudgeSeq += 1;
    c.agentRunStarted = false;
  }
}
