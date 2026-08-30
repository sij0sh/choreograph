import { dirname } from "node:path";
import { LIMITS } from "../domain/limits.ts";
import { processSpecFor } from "../domain/node.ts";
import type { ArtifactSink } from "../domain/artifacts.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { isParked, type Execution } from "../domain/execution.ts";
import type { Issue } from "../engine/interpreter.ts";
import { processLeafAt, transition as engineTransition } from "../engine/interpreter.ts";
import { activeSnapshot } from "../persistence/snapshot.ts";
import { withinMemoryBound, WorkflowStorageError } from "../persistence/store.ts";
import { resolveScriptInputs } from "./artifacts.ts";
import { controlMessage } from "./prompts.ts";
import { captureScriptFiles } from "./script-capture.ts";
import type { NodeResult } from "./runner.ts";
import type { ActiveState, UiContext } from "./coordinator.ts";
import type { CoordinatorInternals } from "./internal.ts";

export async function deliverPending(c: CoordinatorInternals): Promise<void> {
  if (c.suppressDelivery || c.state.status !== "active" || c.state.delivered) return;
  const pending = c.state;
  const process = processLeafAt(pending.workflow, pending.execution);
  if (process && !isParked(pending.execution)) return;
  const leaf = pending.execution.stack[pending.execution.stack.length - 1];
  const message = process && isParked(pending.execution)
    ? [
        controlMessage(pending.execution),
        "",
        "The process at this position failed and its retries are exhausted. The run stays parked here.",
        `Last failure: ${pending.execution.checkpoints[process.key]?.summary ?? "unavailable"}.`,
        "Fix the cause if needed, then call `workflow_retry` to re-run the process, or `workflow_abort` to stop the run.",
      ].join("\n")
    : controlMessage(pending.execution);
  const delivered = await c.delivery.deliver({
    runId: pending.execution.runId,
    key: leaf ? `${leaf.key}#attempt-${"attempt" in leaf ? leaf.attempt : 1}` : "start",
    message,
    isLive: () => c.state === pending,
  });
  if (delivered && c.state === pending) c.state = { ...pending, delivered: true };
}

export function dispatchAgent(c: CoordinatorInternals, active: ActiveState, leaf: Execution["stack"][number]): void {
  const invocation = active.execution.invocations?.[leaf.key] ?? {
    blockId: leaf.blockId,
    key: leaf.key,
    runner: "agent" as const,
    status: "running" as const,
    attempt: "attempt" in leaf ? leaf.attempt : 1,
  };
  c.registry.dispatch(invocation, { runner: "agent", blockId: leaf.blockId });
}

export function settleAgent(
  c: CoordinatorInternals,
  active: ActiveState,
  raw: { readonly status: "completed" | "needs-work" | "blocked"; readonly met?: readonly string[]; readonly checkpoint: Checkpoint; readonly issues?: readonly Issue[] },
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
        ...(raw.issues !== undefined ? { issues: [...raw.issues] } : {}),
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

export async function drive(c: CoordinatorInternals, active: ActiveState, ctx: UiContext, rerun = false): Promise<Execution> {
  if (!rerun && processLeafAt(active.workflow, active.execution) && isParked(active.execution)) {
    await deliverPending(c);
    return active.execution;
  }
  return await driveLoop(c, active, ctx);
}

async function driveLoop(c: CoordinatorInternals, active: ActiveState, ctx: UiContext): Promise<Execution> {
  let current = active;
  let execution = active.execution;
  while (c.state === current) {
    const process = processLeafAt(current.workflow, current.execution);
    if (!process) {
      const agentLeaf = current.execution.stack[current.execution.stack.length - 1];
      if (agentLeaf && (agentLeaf.kind === "task" || agentLeaf.kind === "plan" || agentLeaf.kind === "node")) {
        dispatchAgent(c, current, agentLeaf);
      }
      await deliverPending(c);
      return execution;
    }
    const processKey = process.key;
    const leaf = current.execution.stack[current.execution.stack.length - 1];
    const recorded = current.execution.invocations?.[processKey];
    const reexecution = recorded !== undefined && recorded.status !== "running";
    const attempt = reexecution ? recorded.attempt + 1 : recorded?.attempt ?? (leaf && "attempt" in leaf ? leaf.attempt : 1);
    const invocation = { ...(recorded ?? { blockId: process.blockId, key: processKey, runner: "process" as const, attempt }), status: "running" as const, attempt };
    const processSpec = processSpecFor(process.script, process.blockId, dirname(current.workflow.overviewPath));
    const store = c.artifactStoreFor(current.workflow, current.execution.runId);
    const sink = store.sinkFor(processKey);
    const resolved = resolveScriptInputs(
      current.workflow,
      current.execution,
      process.inputs,
      (ref) => store.materialize(ref, processSpec.cwd),
    );
    if (!resolved.ok) {
      ctx.ui.notify(`Script ${processKey} could not run: ${resolved.error}. The run stays at ${processKey}.`, "error");
      return execution;
    }
    const result = await c.registry
      .dispatch(invocation, processSpec, resolved.inputs, invocation.attempt > 1 ? { acknowledgedRetry: true } : undefined)
      .result;
    if (c.state !== current) return execution;
    if (result.status === "canceled") {
      return execution;
    }
    if (!result.exit) {
      ctx.ui.notify(`Script ${processKey} could not run: ${result.reason ?? "unknown runner error"}. The run stays at ${processKey}.`, "error");
      return execution;
    }
    const exit = result.exit;
    if (exit.cancelled) {
      return execution;
    }
    const captured = captureScriptFiles(processKey, processSpec.spec, processSpec.cwd, store, exit);
    publishLogs(c, current.execution.runId, processKey, sink, exit);
    const applied = engineTransition(current.workflow, current.execution, { type: "process-exit", key: processKey, exit, ...captured, store: sink }, store);
    if (!applied.ok) {
      ctx.ui.notify(`Result for ${processKey} could not be applied: ${applied.error}. The run stays at ${processKey}.`, "error");
      return execution;
    }
    execution = applied.state;
    if (applied.effect.kind === "complete") {
      await c.finishRun(current, ctx, "completed", applied.state);
      return execution;
    }
    const parked = applied.effect.kind === "stay";
    const next: ActiveState = { ...current, execution: applied.state, delivered: false };
    const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: false });
    if (!withinMemoryBound(pendingSnapshot)) {
      ctx.ui.notify(`The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB after process ${processKey}; the run is paused. Abort the run or narrow the workflow outputs.`, "error");
      return execution;
    }
    try {
      c.commit(c.snapshotOf(next, false), `process ${processKey} in ${current.workflow.title} run ${current.execution.runId}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      ctx.ui.notify(`${error.message}. The run stays at ${processKey}.`, "error");
      return execution;
    }
    c.adoptActive(next, ctx);
    if (parked) {
      await deliverPending(c);
      return execution;
    }
    current = next;
  }
  return execution;
}
