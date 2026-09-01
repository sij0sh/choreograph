import { isAbsolute } from "node:path";
import { isToolsBearingBlock, type Workflow } from "../domain/workflow.ts";
import { workflowBlocks } from "../domain/workflow.ts";
import { countSnapshotEntries, latestSnapshot, snapshotBytesInBranch } from "../persistence/store.ts";
import { validateAgainstWorkflow } from "../persistence/validate-stored-run.ts";
import { WorkflowCompileError } from "./workflow-definition.ts";
import { preparedTransfer, ROLLOVER_COMMAND } from "./transfer.ts";
import { sweepWorkflowArtifacts } from "./retention.ts";
import { notifyDriveFailure, type FailureIdentity } from "./commit-failures.ts";
import type { ActiveState, UiContext } from "./types.ts";
import type { CoordinatorInternals } from "./internal.ts";

function blocksWithTools(workflow: Workflow): readonly (readonly string[])[] {
  return workflowBlocks(workflow)
    .filter(isToolsBearingBlock)
    .map((block) => block.tools ?? []);
}

export function startSession(c: CoordinatorInternals, ctx: UiContext): { unknownTools: string[] } {
  c.state = { status: "idle" };
  c.baselineTools = null;
  c.isolationRunId = undefined;
  c.snapshotEntries = 0;
  c.snapshotBytes = 0;
  c.snapshotByteLog.length = 0;
  c.delivery.reset();
  c.lastTerminal = undefined;
  c.settleGuard.reset();
  void c.registry.cancelAll();
  c.notifyCtx.current = ctx;
  const sessionDir = ctx.sessionManager?.getSessionDir?.();
  c.runtimeArtifactRoot = sessionDir && isAbsolute(sessionDir) ? sessionDir : undefined;
  const available = new Set(c.knownTools());
  const unknownTools: string[] = [];
  for (const workflow of c.workflows) {
    const configured = new Set<string>([
      ...(workflow.tools ?? []),
      ...[...workflow.operators.values()].flatMap((operator) => [...(operator.tools ?? [])]),
    ]);
    for (const block of blocksWithTools(workflow)) {
      for (const tool of block) configured.add(tool);
    }
    for (const tool of configured) {
      if (!available.has(tool)) unknownTools.push(`${workflow.name}: ${tool}`);
    }
  }
  c.setTools();
  sweepWorkflowArtifacts(c.workflows, c.defaultArtifactRoot ?? c.runtimeArtifactRoot, undefined, (message, level) => ctx.ui.notify(message, level));
  restoreRun(c, ctx);
  c.setTools();
  c.showStatus(ctx);
  return { unknownTools };
}

export function restoreRun(c: CoordinatorInternals, ctx: UiContext): void {
  const branch = ctx.sessionManager?.getBranch() ?? [];
  c.snapshotEntries = countSnapshotEntries(branch);
  c.snapshotBytes = snapshotBytesInBranch(branch);
  const pendingTransfer = preparedTransfer(branch);
  if (pendingTransfer) {
    c.state = { status: "rollover-pending", transfer: pendingTransfer.transfer };
    c.isolationRunId = pendingTransfer.transfer.runId;
    ctx.ui.notify(`Following workflow run \`${pendingTransfer.transfer.runId}\` to its bounded child session.`, "info");
    c.pi.sendUserMessage(`/${ROLLOVER_COMMAND} ${pendingTransfer.transfer.transferId}`, { expandPromptTemplates: true });
    return;
  }
  const snapshot = latestSnapshot(branch);
  if (!snapshot) return;
  if (snapshot.status === "invalid") {
    ctx.ui.notify(`Dropped active workflow run: malformed snapshot (${snapshot.error}). Start the workflow again.`, "warning");
    return;
  }
  if (snapshot.status === "rollover-pending") {
    ctx.ui.notify(`Workflow rollover ${snapshot.transferId} is pending but its transfer record is missing.`, "error");
    return;
  }
  if (snapshot.status !== "active" && snapshot.status !== "paused") return;
  const workflow = c.workflows.find((item) => item.name === snapshot.workflow);
  if (!workflow) {
    ctx.ui.notify(`Cannot resume ${snapshot.workflow} run: that workflow no longer exists.`, "warning");
    return;
  }
  const migrated = validateAgainstWorkflow(workflow, snapshot.execution);
  if (!migrated.ok) {
    ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.execution.runId}\`: ${migrated.error}.`, "warning");
    return;
  }
  let expectedDigest: string | undefined;
  try {
    expectedDigest = c.frozen.frozenFor(workflow).digest;
  } catch (error) {
    const detail = error instanceof WorkflowCompileError ? error.detail : error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.execution.runId}\`: its definition no longer compiles (${detail}). Restore the files, then start the workflow again.`, "warning");
    return;
  }
  if (expectedDigest && snapshot.execution.definitionDigest !== undefined && snapshot.execution.definitionDigest !== expectedDigest) {
    ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.execution.runId}\`: the workflow changed since the run started (definition digest mismatch). Start the workflow again.`, "warning");
    return;
  }
  c.frozen.freezePromptSources(workflow);
  // Snapshots written before workflow_retry was gated may carry it in baselineTools.
  c.baselineTools = (snapshot.baselineTools ?? c.knownTools())
    .filter((name) => !c.isWorkflowTool(name));
  if (snapshot.status === "paused") {
    const state: ActiveState = { status: "paused", workflow, execution: migrated.execution, delivered: snapshot.delivered };
    c.isolationRunId = state.execution.runId;
    c.adoptActive(state, ctx);
    ctx.ui.notify(`Resumed ${workflow.title} run \`${state.execution.runId}\` paused at ${state.execution.stack.at(-1)?.key}. Resume it with /workflow-resume, or abort the run.`, "info");
    return;
  }
  const state: ActiveState = {
    status: "active",
    workflow,
    execution: migrated.execution,
    delivered: snapshot.delivered,
  };
  c.isolationRunId = state.execution.runId;
  c.adoptActive(state, ctx);
  ctx.ui.notify(`Resumed ${workflow.title} run \`${state.execution.runId}\` at ${state.execution.stack.at(-1)?.key}.`, "info");
  // corr-d2: the resumed drive owns its failures. An unobserved rejection here
  // kills the host and re-crashes on every restart of a cap-full session.
  const identity: FailureIdentity = { workflow: workflow.name, runId: state.execution.runId };
  const position = state.execution.stack.at(-1)?.key;
  c.drive(state, ctx).catch((error: unknown) => notifyDriveFailure(c, error, ctx, identity, state, position));
}
