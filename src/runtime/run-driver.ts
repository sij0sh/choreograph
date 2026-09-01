import { dirname } from "node:path";
import { LIMITS } from "../domain/limits.ts";
import { processSpecFor } from "../domain/invocation.ts";
import type { ArtifactSink } from "../domain/artifacts.ts";
import {
  frameAttempt,
  isAgentDispatchFrame,
  isParked,
  type AgentDispatchFrame,
  type Run,
  upsertInvocation,
} from "../domain/run.ts";
import { processLeafAt, transition as engineTransition, type TaskOutcome } from "../engine/interpreter.ts";
import { activeSnapshot } from "../persistence/snapshot.ts";
import { withinMemoryBound, SnapshotByteBudgetReached, SnapshotCapReached, WorkflowStorageError } from "../persistence/store.ts";
import { resolveScriptInputs } from "./artifacts.ts";
import { consultFence, removeFence } from "./fence.ts";
import { controlMessage } from "./prompts.ts";
import { captureScriptFiles } from "./script-capture.ts";
import type { NodeResult } from "./runner.ts";
import type { ActiveState, ToolResult, UiContext } from "./coordinator.ts";
import { resultText } from "./commit-failures.ts";
import type { CoordinatorInternals } from "./internal.ts";
import { liveRunState } from "./types.ts";

export async function deliverPending(c: CoordinatorInternals): Promise<void> {
  const pending = liveRunState(c.state);
  if (c.suppressDelivery || !pending || pending.delivered) return;
  const process = processLeafAt(pending.workflow, pending.execution);
  if (process && !isParked(pending.execution)) return;
  const leaf = pending.execution.stack[pending.execution.stack.length - 1];
  const message = process && isParked(pending.execution)
    ? [
        controlMessage(pending.execution),
        "",
        "The process at this position failed and the run is parked here.",
        `Last failure: ${pending.execution.checkpoints[process.key]?.summary ?? "unavailable"}.`,
        "Fix the cause if needed, then call `workflow_retry` to re-run the process, or `workflow_abort` to stop the run.",
      ].join("\n")
    : controlMessage(pending.execution);
  const delivered = await c.delivery.deliver({
    runId: pending.execution.runId,
    key: leaf ? `${leaf.key}#attempt-${frameAttempt(leaf)}` : "start",
    message,
    isLive: () => c.state === pending,
  });
  if (delivered && c.state === pending) c.state = { ...pending, delivered: true };
}

/**
 * corr-d4: a dispatch-time failure parks the run at the script leaf (invocation
 * "waiting") instead of stranding it at a position that workflow_retry refuses
 * and delivery skips. In-memory only: no commit is added on the failure path, so
 * a crash here self-heals on restore via the fence-dead re-dispatch.
 */
async function parkOnDispatchFailure(
  c: CoordinatorInternals,
  current: ActiveState,
  ctx: UiContext,
  processKey: string,
  detail: string,
  attempt: number,
): Promise<Run> {
  const leaf = current.execution.stack[current.execution.stack.length - 1];
  const base = current.execution.invocations?.[processKey] ?? {
    blockId: leaf?.blockId ?? processKey,
    key: processKey,
    runner: "process" as const,
    attempt,
  };
  const run: Run = {
    ...current.execution,
    invocations: upsertInvocation(current.execution, processKey, { ...base, status: "waiting", attempt }),
  };
  ctx.ui.notify(`${detail} The run is parked at ${processKey}; fix the cause, then call workflow_retry to re-run it or workflow_abort to stop the run.`, "error");
  c.adoptActive({ ...current, execution: run, delivered: false }, ctx);
  await deliverPending(c);
  return run;
}

export function dispatchAgent(c: CoordinatorInternals, active: ActiveState, leaf: AgentDispatchFrame): void {
  const invocation = active.execution.invocations?.[leaf.key] ?? {
    blockId: leaf.blockId,
    key: leaf.key,
    runner: "agent" as const,
    status: "running" as const,
    attempt: frameAttempt(leaf),
  };
  c.registry.dispatch(invocation, { runner: "agent", blockId: leaf.blockId });
}

export function settleAgent(
  c: CoordinatorInternals,
  active: ActiveState,
  raw: TaskOutcome,
): void {
  const key = active.execution.stack.at(-1)?.key;
  if (!key) return;


  const data = raw.checkpoint.data;
  const result: NodeResult = raw.status === "completed"
    ? {
        status: "succeeded",
        summary: raw.checkpoint.summary,
        ...(data !== undefined ? { data } : {}),
        ...(raw.met !== undefined ? { met: [...raw.met] } : {}),
      }
    : {
        status: "failed",
        reason: raw.status,
        summary: raw.checkpoint.summary,
        ...(data !== undefined ? { data } : {}),
        ...(raw.status === "needs-work" && raw.issues !== undefined ? { issues: [...raw.issues] } : {}),
      };
  c.registry.complete(key, result);
}

export function publishLogs(c: CoordinatorInternals, runId: string, key: string, sink: ArtifactSink, exit: { readonly stdout: string; readonly stderr: string; readonly truncated: boolean }): void {
  for (const stream of ["stdout", "stderr"] as const) {
    const text = exit[stream];
    if (!text) continue;
    try {
      sink.publishText(stream, text);
    } catch {
      // Log artifacts are best effort.
    }
  }
}

export async function drive(c: CoordinatorInternals, active: ActiveState, ctx: UiContext, rerun = false): Promise<Run> {
  if (!rerun && processLeafAt(active.workflow, active.execution) && isParked(active.execution)) {
    await deliverPending(c);
    return active.execution;
  }
  return await driveLoop(c, active, ctx);
}

async function driveLoop(c: CoordinatorInternals, active: ActiveState, ctx: UiContext): Promise<Run> {
  let current = active;
  let execution = active.execution;
  while (c.state === current) {
    const process = processLeafAt(current.workflow, current.execution);
    if (!process) {
      const agentLeaf = current.execution.stack[current.execution.stack.length - 1];
      if (agentLeaf && isAgentDispatchFrame(agentLeaf)) {
        dispatchAgent(c, current, agentLeaf);
      }
      await deliverPending(c);
      return execution;
    }
    const processKey = process.key;
    const leaf = current.execution.stack[current.execution.stack.length - 1];
    const recorded = current.execution.invocations?.[processKey];
    const reexecution = recorded !== undefined && recorded.status !== "running";
    const processSpec = processSpecFor(process.script, process.blockId, dirname(current.workflow.overviewPath));
    let attempt = reexecution ? recorded.attempt + 1 : recorded?.attempt ?? (leaf ? frameAttempt(leaf) : 1);
    if (recorded?.status === "running") {
      // Resuming a leaf recorded "running": the durable fence left by the
      // previous instance admits the re-dispatch or parks the run.
      const fence = consultFence(processSpec.cwd, processKey);
      if (fence.status === "alive") {
        return await parkOnDispatchFailure(c, current, ctx, processKey, `Script ${processKey} is still running in another process (pid ${fence.pid}; fence ${fence.path}). Stop that process or wait for it to exit.`, attempt);
      }
      if (fence.status === "dead" && attempt < LIMITS.nodeAttempts + 1) attempt += 1;
    }
    const invocation = { ...(recorded ?? { blockId: process.blockId, key: processKey, runner: "process" as const, attempt }), status: "running" as const, attempt };
    const store = c.artifactStoreFor(current.workflow, current.execution.runId);
    const sink = store.sinkFor(processKey);
    const resolved = resolveScriptInputs(
      current.workflow,
      current.execution,
      process.inputs,
      (ref) => store.materialize(ref, processSpec.cwd),
    );
    if (!resolved.ok) {
      return await parkOnDispatchFailure(c, current, ctx, processKey, `Script ${processKey} could not run: ${resolved.error}.`, attempt);
    }
    const result = await c.registry
      .dispatch(invocation, processSpec, resolved.inputs, invocation.attempt > 1 ? { acknowledgedRetry: true } : undefined)
      .result;
    if (c.state !== current) return execution;
    if (result.status === "canceled") {
      removeFence(processSpec.cwd, processKey);
      return execution;
    }
    if (!result.exit) {
      return await parkOnDispatchFailure(c, current, ctx, processKey, `Script ${processKey} could not run: ${result.reason ?? "unknown runner error"}.`, attempt);
    }
    const exit = result.exit;
    if (exit.cancelled) {
      removeFence(processSpec.cwd, processKey);
      return execution;
    }
    const captured = captureScriptFiles(processKey, processSpec.spec, processSpec.cwd, store, exit);
    publishLogs(c, current.execution.runId, processKey, sink, exit);
    const applied = engineTransition(current.workflow, current.execution, { type: "process-exit", key: processKey, exit, ...captured, store: sink }, store);
    if (!applied.ok) {
      return await parkOnDispatchFailure(c, current, ctx, processKey, `Result for ${processKey} could not be applied: ${applied.error}.`, attempt);
    }
    execution = applied.state;
    if (applied.effect.kind === "complete") {
      let result: ToolResult | undefined;
      await c.runTerminalExclusive(undefined, async () => {
        // corr-c8: the lock wait can overlap an abort; never double-commit a terminal record.
        if (c.state.status === "active") result = await c.finishRun(current, ctx, "completed", applied.state);
      });
      // corr-d3: the driver owns the completion result; a failed terminal commit
      // must reach the user, not vanish inside a discarded ToolResult.
      if (result?.isError) ctx.ui.notify(resultText(result), "error");
      return execution;
    }
    const parked = applied.effect.kind === "stay";
    const next: ActiveState = { ...current, execution: applied.state, delivered: false };
    const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: false });
    if (!withinMemoryBound(pendingSnapshot)) {
      // The promise becomes the state: the run parks and the marker persists.
      c.pauseRun(ctx);
      ctx.ui.notify(`The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB after process ${processKey}; the run is paused. Abort the run or narrow the workflow outputs.`, "error");
      return execution;
    }
    try {
      c.commit(c.snapshotOf(next, false), `process ${processKey} in ${current.workflow.title} run ${current.execution.runId}`);
    } catch (error) {
      if (error instanceof SnapshotCapReached || error instanceof SnapshotByteBudgetReached) {
        // The driver cannot roll over; the transition/retry caller owns that choice.
        throw error;
      }
      if (!(error instanceof WorkflowStorageError)) throw error;
      ctx.ui.notify(`${error.message}. The run stays at ${processKey}.`, "error");
      return execution;
    }
    removeFence(processSpec.cwd, processKey);
    c.adoptActive(next, ctx);
    if (parked) {
      await deliverPending(c);
      return execution;
    }
    current = next;
  }
  return execution;
}
