import { frameAttempt, isAgentDispatchFrame } from "../domain/run.ts";
import { LIMITS } from "../domain/limits.ts";
import { controlMessage } from "./prompts.ts";
import type { ActiveState, RunState, UiContext } from "./types.ts";
import { liveRunState } from "./types.ts";
import type { DeliveryCoordinator } from "./delivery.ts";
import type { RunnerRegistry } from "./registry.ts";

/** The narrow surface the guard needs from its host. */
export interface SettleGuardHost {
  readonly state: RunState;
  readonly delivery: DeliveryCoordinator;
  readonly registry: RunnerRegistry;
}

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
 *
 * The concern owns its episode state and reset policy (R4): no host assigns
 * its fields, and every episode begins at a reset().
 */
export class SettleGuard {
  private agentRunStarted = false;
  private transitionSeen = false;
  private stallCount = 0;
  private nudgeSeq = 0;
  private stalledNotified = false;

  /** A new episode - run start, session start - carries no settle bookkeeping. */
  reset(): void {
    this.agentRunStarted = false;
    this.transitionSeen = false;
    this.stallCount = 0;
    this.nudgeSeq = 0;
    this.stalledNotified = false;
  }

  noteAgentStart(): void {
    this.agentRunStarted = true;
  }

  /** An engine-accepted transition concludes the position: no nudge, episode reset. */
  noteTransition(): void {
    this.transitionSeen = true;
    this.stallCount = 0;
    this.stalledNotified = false;
  }

  async guard(host: SettleGuardHost, ctx: UiContext): Promise<void> {
    const active: ActiveState | undefined = liveRunState(host.state);
    const ran = this.agentRunStarted;
    const transitioned = this.transitionSeen;
    this.transitionSeen = false;
    if (!active || !ran || transitioned) {
      this.agentRunStarted = false;
      return;
    }
    const leaf = active.execution.stack[active.execution.stack.length - 1];
    const stalled = Boolean(
      leaf
      && isAgentDispatchFrame(leaf)
      && active.delivered
      && !host.registry.executesCurrentLeaf(active.workflow, active.execution),
    );
    if (!stalled) {
      this.agentRunStarted = false;
      return;
    }
    if (this.stallCount >= LIMITS.settleNudges) {
      this.agentRunStarted = false;
      if (!this.stalledNotified) {
        this.stalledNotified = true;
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
    const delivered = await host.delivery.deliver({
      runId: active.execution.runId,
      key: `${leaf.key}#attempt-${frameAttempt(leaf)}#nudge-${this.nudgeSeq + 1}`,
      message,
      isLive: () => host.state === active,
    });
    if (delivered && host.state === active) {
      this.stallCount += 1;
      this.nudgeSeq += 1;
      this.agentRunStarted = false;
    }
  }
}
