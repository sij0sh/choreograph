import { randomBytes } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { AgentRunner, ProcessRunner } from "./runner.ts";
import { RunnerRegistry } from "./registry.ts";
import { AsyncMutex } from "./mutex.ts";
import { refLoaderFor } from "./artifacts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { dirname, isAbsolute } from "node:path";
import { start as engineStart } from "../engine/interpreter.ts";
import type { TaskOutcome } from "../engine/interpreter.ts";
import type { Execution } from "../domain/execution.ts";
import { LIMITS } from "../domain/limits.ts";
import type { Workflow } from "../domain/workflow.ts";
import { SnapshotByteBudgetReached, SnapshotCapReached, WorkflowStorageError, type SnapshotStore } from "../persistence/store.ts";
import { activeSnapshot, deliveredTombstone, SNAPSHOT_TYPE, terminalSnapshot } from "../persistence/snapshot.ts";
import { effectiveTools, CONTROL_TOOLS } from "./capabilities.ts";
import { readBlockFrom, renderPositionEnvelope, renderReportEnvelope, rosterPrompt } from "./prompts.ts";
import { createContextIsolator, type IsolatableMessage } from "./isolation.ts";
import { statusValue } from "./status.ts";
import { DeliveryCoordinator } from "./delivery.ts";
import { deliverPending as deliverPendingNow, drive as driveRun, settleAgent as settleAgentNow } from "./execution-driver.ts";
import { performRollover as performRolloverNow, prepareRollover as prepareRolloverNow } from "./rollover.ts";
import { sweepWorkflowArtifacts } from "./retention.ts";
import { runTransition } from "./transition.ts";
import { guardSettled } from "./settle-guard.ts";
import { retryRun } from "./retry.ts";
import { finishRun as finishRunNow, runAbort } from "./finish-run.ts";
import { restoreRun as restoreRunNow, startSession } from "./session.ts";
import { FrozenSources } from "./frozen-definition.ts";
export { WorkflowCompileError } from "./frozen-definition.ts";
import type { ActiveState, PiFacade, RunState, ToolResult, UiContext } from "./types.ts";
export type { ActiveState, PiFacade, RunState, ToolResult, UiContext } from "./types.ts";
import { assertNotCancelled, type CoordinatorInternals } from "./internal.ts";

export const START_TOOL_NAME = "workflow_start";

/** Used when a workflow is started without an explicit target. */
export const DEFAULT_TARGET = "the entire project";

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Per-commit serialized byte sizes kept for observability; a bounded ring, never a session leak. */
const SNAPSHOT_BYTE_LOG_MAX = 1024;

export class RuntimeCoordinator {
  readonly workflows: readonly Workflow[];
  readonly visibleWorkflows: readonly Workflow[];
  readonly registry = new RunnerRegistry([new AgentRunner(), new ProcessRunner()]);
  readonly frozen: FrozenSources;
  private readonly pi: PiFacade;
  private readonly store: SnapshotStore;
  private state: RunState = { status: "idle" };
  private snapshotEntries: number | null = null;
  private snapshotBytes = 0;
  private readonly snapshotByteLog: number[] = [];
  private baselineTools: string[] | null = null;
  private readonly delivery: DeliveryCoordinator;
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private runtimeArtifactRoot: string | undefined;
  private readonly defaultArtifactRoot: string | undefined;
  private isolationRunId: string | undefined;
  private readonly contextIsolator = createContextIsolator();
  private suppressDelivery = false;
  /** Serializes the abort terminal commit against transition epilogue sampling (corr-c8). */
  private readonly terminalLock = new AsyncMutex();
  /** Terminal status of the run-ending event that just landed; single-slot because abort and completion cannot interleave under the lock (corr-c8). */
  private lastTerminal: "completed" | "aborted" | undefined;
  // Settle-guard bookkeeping; consumed and cleared by guardSettled on every settle.
  private agentRunStarted = false;
  private transitionSeen = false;
  private stallCount = 0;
  private nudgeSeq = 0;
  private stalledNotified = false;
  private notifyCtx: { current?: UiContext } = {};

  constructor(pi: RuntimeCoordinator["pi"], workflows: readonly Workflow[], read?: ReturnType<typeof readBlockFrom>, defaultArtifactRoot?: string) {
    this.pi = pi;
    this.workflows = workflows;
    this.visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
    this.store = {
      append: (snapshot) => this.pi.appendEntry(SNAPSHOT_TYPE, snapshot),
    };
    this.frozen = new FrozenSources(read);
    this.defaultArtifactRoot = defaultArtifactRoot;
    this.delivery = new DeliveryCoordinator({
      send: async (message) => {
        await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
      },
      commitDelivered: () => {
        try {
          // fx5b: an O(1) tombstone replaces the full-state delivered commit; readers
          // accept both formats. No active state keeps the legacy fallback.
          const active = this.state.status === "active" ? this.state : undefined;
          this.commit(active ? deliveredTombstone(active.execution.runId) : this.snapshotOf(undefined, true), `delivered marker`);
        } catch (error) {
          // Best effort: a missing delivered marker only re-delivers after a resume.
          if (!(error instanceof SnapshotCapReached) && !(error instanceof SnapshotByteBudgetReached)) throw error;
        }
      },
      notify: (message, level) => this.notifyCtx.current?.ui.notify(message, level),
    });
  }

  /** Total serialized snapshot payload bytes committed this session (fx5a observability). */
  get committedSnapshotBytes(): number {
    return this.snapshotBytes;
  }

  /** Recent per-commit serialized byte sizes, oldest first; feeds the dx-c5 delta research. */
  get snapshotCommitBytes(): readonly number[] {
    return this.snapshotByteLog;
  }

  private commit(snapshot: unknown, operation: string, options?: { readonly bypassCap?: boolean }): void {
    // Bound snapshot history per session: rollover-capable hosts roll to a fresh
    // child session at either cap; embedders pause the run. The rollover marker
    // itself bypasses both caps so the handoff can always be recorded.
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (!options?.bypassCap) {
      if (this.snapshotEntries !== null && this.snapshotEntries >= LIMITS.snapshotEntriesPerSession) {
        throw new SnapshotCapReached(LIMITS.snapshotEntriesPerSession);
      }
      if (this.snapshotBytes + bytes > LIMITS.snapshotBytesPerSession) {
        throw new SnapshotByteBudgetReached(LIMITS.snapshotBytesPerSession, this.snapshotBytes + bytes);
      }
    }
    try {
      this.store.append(snapshot);
      if (this.snapshotEntries !== null) this.snapshotEntries += 1;
      this.snapshotBytes += bytes;
      this.snapshotByteLog.push(bytes);
      if (this.snapshotByteLog.length > SNAPSHOT_BYTE_LOG_MAX) this.snapshotByteLog.shift();
    } catch (cause) {
      throw new WorkflowStorageError(operation, cause);
    }
  }

  private now(): number {
    return Date.now();
  }

  /**
   * The run's artifact store, rooted under the workflow directory so retention stays per-run.
   */
  private artifactStoreFor(workflow: Workflow, runId: string): ArtifactStore {
    const cached = this.artifactStores.get(runId);
    if (cached) return cached;
    const workflowDir = dirname(workflow.overviewPath);
    const dir = isAbsolute(workflowDir) && existsSync(workflowDir)
      ? workflowDir
      : this.defaultArtifactRoot ?? this.runtimeArtifactRoot;
    if (!dir) throw new Error(`run ${runId} cannot resolve an artifact store root for workflow ${workflow.name}`);
    const store = ArtifactStore.forRun(dir, runId);
    if (!store) throw new Error(`run ${runId} cannot resolve an absolute artifact store root`);
    this.artifactStores.set(runId, store);
    return store;
  }

  /** Terminal release (fx3): the per-run ArtifactStore entry must not outlive the run
   * (about 789 B/entry on a session-lifetime Map); a later lookup re-creates it.
   * Mid-run rollovers keep the entry - only terminal run states release it. */
  private releaseArtifacts(runId: string): void {
    this.artifactStores.delete(runId);
  }

  private snapshotOf(state: ActiveState | undefined, delivered: boolean): unknown {
    if (!state) return terminalSnapshot("aborted", "", "");
    this.baselineTools ??= this.captureBaseline();
    return activeSnapshot({
      workflow: state.workflow.name,
      execution: state.execution,
      delivered,
      baselineTools: this.baselineTools,
    });
  }

  private readonly isWorkflowTool = (name: string): boolean => [START_TOOL_NAME, ...CONTROL_TOOLS].includes(name);
  private readonly knownTools = (): string[] => this.pi.getAllTools?.().map((tool) => tool.name) ?? this.pi.getActiveTools();
  private readonly captureBaseline = (): string[] => this.pi.getActiveTools().filter((name) => !this.isWorkflowTool(name));

  private activeToolsFor(state: RunState): string[] {
    this.baselineTools ??= this.captureBaseline();
    if (state.status !== "active") {
      const idle = [...this.baselineTools];
      return this.visibleWorkflows.length ? [...idle, START_TOOL_NAME] : idle;
    }
    const active = effectiveTools(state.workflow, state.execution, this.baselineTools);
    const registered = new Set(this.knownTools());
    return active.filter((name) => registered.has(name) || CONTROL_TOOLS.includes(name));
  }

  private setTools(): void {
    this.pi.setActiveTools(this.activeToolsFor(this.state));
  }

  private showStatus(ctx: UiContext): void {
    const active = this.state.status === "active" ? this.state : undefined;
    ctx.ui.setWidget?.("choreograph-details", undefined);
    ctx.ui.setStatus("choreograph", active ? statusValue(active.workflow, active.execution) : undefined);
  }

  private requireActive(): ActiveState {
    if (this.state.status !== "active") throw new Error("no active workflow");
    return this.state;
  }

  /** Runs fn while holding the terminal lock (corr-c8). A fired signal unblocks a queued caller. */
  private async runTerminalExclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const release = await this.terminalLock.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async deliverPending(): Promise<void> {
    await deliverPendingNow(this as unknown as CoordinatorInternals);
  }

  private settleAgent(active: ActiveState, outcome: TaskOutcome): void {
    settleAgentNow(this as unknown as CoordinatorInternals, active, outcome);
  }

  private adoptActive(state: ActiveState, ctx: UiContext): void {
    this.state = state;
    this.setTools();
    this.showStatus(ctx);
  }

  private supportsSessionRollover(ctx: UiContext): boolean {
    return typeof ctx.sessionManager?.getSessionDir === "function" && Boolean(ctx.sessionManager.getSessionFile?.());
  }

  renderReport(workflow: Workflow, execution: Execution): string {
    return renderReportEnvelope(workflow, execution, this.frozen.promptRead);
  }

  private prepareRollover(workflow: Workflow, execution: Execution, snapshot: unknown, terminal: boolean, ctx: UiContext): boolean {
    return prepareRolloverNow(this as unknown as CoordinatorInternals, workflow, execution, snapshot, terminal, ctx);
  }

  private async drive(active: ActiveState, ctx: UiContext, rerun = false): Promise<Execution> {
    return driveRun(this as unknown as CoordinatorInternals, active, ctx, rerun);
  }

  private beginRun(workflow: Workflow, target: string, ctx: UiContext): ActiveState {
    const runId = newRunId();
    sweepWorkflowArtifacts(this.workflows, this.defaultArtifactRoot ?? this.runtimeArtifactRoot, runId, (message, level) => ctx.ui.notify(message, level), workflow);
    const started = engineStart(workflow, { runId, target: target.trim() }, this.artifactStoreFor(workflow, runId));
    if (!started.ok) throw new Error(started.error);
    this.frozen.freezePromptSources(workflow);
    const digest = this.frozen.frozenFor(workflow).digest;
    const execution: Execution = { ...started.state, definitionDigest: digest };
    const next: ActiveState = { status: "active", workflow, execution, delivered: false };
    this.commit(this.snapshotOf(next, false), `start of ${workflow.title} run ${next.execution.runId}`);
    this.isolationRunId = next.execution.runId;
    this.lastTerminal = undefined;
    this.agentRunStarted = false;
    this.transitionSeen = false;
    this.stallCount = 0;
    this.nudgeSeq = 0;
    this.stalledNotified = false;
    this.adoptActive(next, ctx);
    ctx.ui.notify(`${workflow.title} started.`, "info");
    return next;
  }

  async startWorkflow(ctx: UiContext, workflow: Workflow, target: string, signal?: AbortSignal): Promise<ActiveState | null> {
    if (this.state.status !== "idle") {
      const description = this.state.status === "active"
        ? `${this.state.workflow.title} run ${this.state.execution.runId} is already active.`
        : `Workflow run ${this.state.transfer.runId} is waiting for a session rollover.`;
      ctx.ui.notify(description, "error");
      return null;
    }
    assertNotCancelled(signal);
    const next = this.beginRun(workflow, target.trim() || DEFAULT_TARGET, ctx);
    const finalExecution = await this.drive(next, ctx);
    return { ...next, execution: finalExecution };
  }

  async transition(params: unknown, signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
    return runTransition(this as unknown as CoordinatorInternals, params, signal, ctx);
  }

  private async finishRun(current: ActiveState, ctx: UiContext, status: "completed" | "aborted", final: Execution): Promise<ToolResult> {
    return finishRunNow(this as unknown as CoordinatorInternals, current, ctx, status, final);
  }

  async abort(signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
    return runAbort(this as unknown as CoordinatorInternals, signal, ctx);
  }

  async retry(signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
    return retryRun(this as unknown as CoordinatorInternals, signal, ctx);
  }

  async performRollover(transferId: string, ctx: ExtensionCommandContext): Promise<void> {
    await performRolloverNow(this as unknown as CoordinatorInternals, transferId, ctx);
  }

  restoreRun(ctx: UiContext): void {
    restoreRunNow(this as unknown as CoordinatorInternals, ctx);
  }

  handleSessionStart(ctx: UiContext): { unknownTools: string[] } {
    return startSession(this as unknown as CoordinatorInternals, ctx);
  }

  handleAgentStart(): void {
    if (this.state.status === "active") this.agentRunStarted = true;
  }

  async handleAgentSettled(ctx: UiContext): Promise<void> {
    this.notifyCtx.current = ctx;
    await this.deliverPending();
    await guardSettled(this as unknown as CoordinatorInternals, ctx);
    if (this.state.status === "idle") this.isolationRunId = undefined;
  }

  handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (this.state.status === "active") {
      const store = this.artifactStoreFor(this.state.workflow, this.state.execution.runId);
      const guide = renderPositionEnvelope(this.state.workflow, this.state.execution, this.frozen.promptRead, refLoaderFor(store), this.activeToolsFor(this.state));
      return { systemPrompt: `${event.systemPrompt}\n\n${guide}` };
    }
    const roster = rosterPrompt(this.visibleWorkflows);
    return roster ? { systemPrompt: `${event.systemPrompt}\n\n${roster}` } : undefined;
  }

  handleContext<T extends IsolatableMessage>(event: { messages: readonly T[] }): { messages: T[] } | undefined {
    const runId = this.state.status === "active" && this.state.delivered ? this.state.execution.runId : this.isolationRunId;
    if (!runId) return undefined;
    const isolated = this.contextIsolator(event.messages, runId);
    return isolated ? { messages: isolated } : undefined;
  }
}
