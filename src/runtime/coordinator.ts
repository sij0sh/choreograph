import { randomBytes } from "node:crypto";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { freezeDefinition, type FrozenDefinition } from "../authoring/compile.ts";
import { AgentRunner, ProcessRunner } from "./runner.ts";
import { RunnerRegistry } from "./registry.ts";
import { AsyncMutex } from "./mutex.ts";
import { refLoaderFor } from "./artifacts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import type { ArtifactRef } from "../domain/artifacts.ts";
import type { ProcessResult } from "./process-runner.ts";
import { dirname, isAbsolute, join, relative } from "node:path";
import { start as engineStart, processLeafAt, transition as engineTransition } from "../engine/interpreter.ts";
import { frameAttempt, isAttemptBearingFrame, upsertInvocation, type Execution } from "../domain/execution.ts";
import { deepEqual, type JsonValue } from "../domain/json.ts";
import { lastSegment } from "../domain/keys.ts";
import { LIMITS } from "../domain/limits.ts";
import type { TaskOutcome } from "../engine/interpreter.ts";
import type { ScriptSpec, Workflow } from "../domain/workflow.ts";
import { blockOf, workflowBlocks } from "../domain/workflow.ts";
import type { NodeResult } from "./runner.ts";
import { countSnapshotEntries, latestSnapshot, SnapshotByteBudgetReached, SnapshotCapReached, snapshotBytesInBranch, withinMemoryBound, WorkflowStorageError, type SnapshotStore } from "../persistence/store.ts";
import { activeSnapshot, deliveredTombstone, SNAPSHOT_TYPE, terminalSnapshot } from "../persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../persistence/validate-stored-execution.ts";
import { effectiveTools, CONTROL_TOOLS } from "./capabilities.ts";
import { readBlockFrom, renderPositionEnvelope, renderReportEnvelope, rosterPrompt, summaryMessage, summaryPrefix } from "./prompts.ts";
import { createContextIsolator, type IsolatableMessage } from "./isolation.ts";
import { preparedTransfer, ROLLOVER_COMMAND, type RolloverTransferV2 } from "./transfer.ts";
import { statusValue } from "./status.ts";
import { DeliveryCoordinator } from "./delivery.ts";
import { deliverPending as deliverPendingNow, drive as driveRun, settleAgent as settleAgentNow } from "./execution-driver.ts";
import { performRollover as performRolloverNow, prepareRollover as prepareRolloverNow } from "./rollover.ts";
import { sweepRunArtifacts, sweepWorkflowArtifacts } from "./retention.ts";
import type { CoordinatorInternals } from "./internal.ts";


export const START_TOOL_NAME = "workflow_start";

/** Used when a workflow is started without an explicit target. */
export const DEFAULT_TARGET = "the entire project";


export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("workflow operation cancelled");
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}


export type PiFacade = {
  getActiveTools(): string[];
  getAllTools?: () => readonly { name: string }[];
  setActiveTools(names: string[]): void;
  appendEntry(type: string, data: unknown): void;
  sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
};
export type UiContext = {
  ui: {
    setStatus(id: string, value: string | undefined): void;
    setWidget?(id: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    notify(message: string, level: "info" | "error" | "warning"): void;
  };
  cwd?: string;
  model?: { contextWindow?: number; maxTokens?: number };
  getSystemPrompt?(): string;
  sessionManager?: {
    getBranch(): unknown[];
    getSessionFile?(): string | undefined;
    getSessionDir?(): string;
    getCwd?(): string;
  };
};

export type ActiveState = {
  status: "active";
  workflow: Workflow;
  execution: Execution;
  delivered: boolean;
};

export type RunState = { status: "idle" } | ActiveState | { status: "rollover-pending"; transfer: RolloverTransferV2 };

/** A workflow definition failed strict compilation (for example, a required file is unreadable); the run must not start. */
export class WorkflowCompileError extends Error {
  readonly detail: string;

  constructor(workflow: Workflow, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot compile the definition of ${workflow.title}: ${detail}. The run did not start; restore the file or fix the definition, then start again.`, { cause });
    this.name = "WorkflowCompileError";
    this.detail = detail;
  }
}

const defaultRead = readBlockFrom({ statSync, readFileSync });

/** Reads the real filesystem strictly: a missing required file is undefined, never an error string. */
const strictRead = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Byte-cap wording shared by every snapshot-byte pause and rollover message (fx5a). */
const byteCapPhrase = (error: SnapshotByteBudgetReached): string =>
  `The session's snapshot log reached ${error.bytes} of ${error.budget} bytes`;
const byteCapPhraseLower = (error: SnapshotByteBudgetReached): string =>
  `the session's snapshot log reached ${error.bytes} of ${error.budget} bytes`;

/** Per-commit serialized byte sizes kept for observability; a bounded ring, never a session leak. */
const SNAPSHOT_BYTE_LOG_MAX = 1024;

export class RuntimeCoordinator {
  readonly workflows: readonly Workflow[];
  readonly visibleWorkflows: readonly Workflow[];
  private readonly frozenCache = new Map<string, FrozenDefinition>();
  readonly registry = new RunnerRegistry([new AgentRunner(), new ProcessRunner()]);
  private readonly pi: PiFacade;
  private readonly store: SnapshotStore;
  private readonly read: ReturnType<typeof readBlockFrom>;
  private readonly injectedReader: boolean;
  private readonly frozenPrompts = new Map<string, string>();
  private readonly promptRead = (path: string, label: string): string => this.frozenPrompts.get(path) ?? this.read(path, label);
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

  constructor(pi: RuntimeCoordinator["pi"], workflows: readonly Workflow[], read?: ReturnType<typeof readBlockFrom>, defaultArtifactRoot?: string) {
    this.pi = pi;
    this.workflows = workflows;
    this.visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
    this.store = {
      append: (snapshot) => this.pi.appendEntry(SNAPSHOT_TYPE, snapshot),
    };
    this.injectedReader = read !== undefined;
    this.read = read ?? defaultRead;
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

  private notifyCtx: { current?: UiContext } = {};

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
   * Freeze prompt sources for the active run. Prompt rendering reads these
   * frozen copies instead of the live files, so a mid-run edit cannot change
   * behavior without a restart or a digest mismatch on resume.
   */
  private freezePromptSources(workflow: Workflow): void {
    this.frozenPrompts.clear();
    const frozen = this.frozenFor(workflow);
    const dir = dirname(workflow.overviewPath);
    const set = (path: string): void => {
      const content = frozen.contents[relative(dir, path)];
      if (content !== undefined) this.frozenPrompts.set(path, content);
    };
    set(workflow.overviewPath);
    for (const operator of workflow.operators.values()) set(operator.path);
    for (const block of workflowBlocks(workflow)) {
      if (block.kind === "task") set(block.instructionPath);
    }
  }

  /**
   * Freeze a workflow's definition lazily and memoize it. An unreadable
   * required file fails the freeze and refuses the run via WorkflowCompileError.
   */
  private frozenFor(workflow: Workflow): FrozenDefinition {
    const cached = this.frozenCache.get(workflow.name);
    if (cached) return cached;
    const reader = this.injectedReader
      ? (path: string): string | undefined => this.read(path, "frozen definition")
      : strictRead;
    try {
      const frozen = freezeDefinition(workflow, reader);
      this.frozenCache.set(workflow.name, frozen);
      return frozen;
    } catch (error) {
      throw new WorkflowCompileError(workflow, error);
    }
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

  /** Truthful response when the run ended while this operation was in flight (corr-c8). */
  private runEndedText(run: ActiveState): ToolResult {
    const ended = this.lastTerminal === "completed" ? "completed" : "was aborted";
    return {
      content: [{ type: "text", text: `${run.workflow.title} run ${run.execution.runId} ${ended} while this operation was in flight. The run is over; no further instructions or deliveries will arrive.` }],
      details: { workflow: run.workflow.name, runId: run.execution.runId, status: this.lastTerminal === "completed" ? "completed" : "aborted" },
      terminate: true,
    };
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
    return renderReportEnvelope(workflow, execution, this.promptRead);
  }

  private prepareRollover(workflow: Workflow, execution: Execution, snapshot: unknown, terminal: boolean, ctx: UiContext): boolean {
    return prepareRolloverNow(this as unknown as CoordinatorInternals, workflow, execution, snapshot, terminal, ctx);
  }

  private beginRun(workflow: Workflow, target: string, ctx: UiContext): ActiveState {
    const runId = newRunId();
    sweepWorkflowArtifacts(this.workflows, this.defaultArtifactRoot ?? this.runtimeArtifactRoot, runId, (message, level) => ctx.ui.notify(message, level), workflow);
    const started = engineStart(workflow, { runId, target: target.trim() }, this.artifactStoreFor(workflow, runId));
    if (!started.ok) throw new Error(started.error);
    this.freezePromptSources(workflow);
    const digest = this.frozenFor(workflow).digest;
    const execution: Execution = { ...started.state, definitionDigest: digest };
    const next: ActiveState = { status: "active", workflow, execution, delivered: false };
    this.commit(this.snapshotOf(next, false), `start of ${workflow.title} run ${next.execution.runId}`);
    this.isolationRunId = next.execution.runId;
    this.lastTerminal = undefined;
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
    const current = this.requireActive();
    assertNotCancelled(signal);
    if (!current.delivered) {
      return {
        content: [{ type: "text", text: `Cannot transition \`${current.execution.stack.at(-1)?.key}\` before its instructions are delivered. They arrive as the next message; finish the current reply first.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "delivery-pending" },
        isError: true,
      };
    }
    const outcome = params as TaskOutcome;
    const result = engineTransition(current.workflow, current.execution, { type: "outcome", outcome }, this.artifactStoreFor(current.workflow, current.execution.runId));
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Invalid transition: ${result.error}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "invalid-transition" },
        isError: true,
      };
    }
    if (result.effect.kind === "complete") {
      return this.runTerminalExclusive(signal, async () => {
        if (this.state.status !== "active") return this.runEndedText(current);
        this.settleAgent(current, outcome);
        return this.finishRun(current, ctx, "completed", result.state);
      });
    }
    // A blocked position waits for the user in this session; rolling it over would respawn the same blocker forever.
    const rollover = this.supportsSessionRollover(ctx) && outcome.status !== "blocked";
    const next: ActiveState = { ...current, execution: result.state, delivered: rollover ? false : result.effect.kind === "stay" };
    const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: next.delivered });
    if (!withinMemoryBound(pendingSnapshot)) {
      return {
        content: [{ type: "text", text: `The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB; the transition was rejected. Abort the run or narrow the checkpoint data.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "memory-bound" },
        isError: true,
      };
    }
    this.settleAgent(current, outcome);
    try {
      this.commit(this.snapshotOf(next, next.delivered), `transition of ${current.workflow.title} run ${current.execution.runId} to ${result.state.stack.at(-1)?.key ?? "completion"}`);
    } catch (error) {
      if (error instanceof SnapshotCapReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, next.execution, pendingSnapshot, false, ctx);
          return {
            content: [{ type: "text", text: `Recorded ${outcome.status}. The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap; the workflow continues at ${next.execution.stack.at(-1)?.key} in a fresh session.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, position: next.execution.stack.at(-1)?.key, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so the transition was not committed. The run stays at ${current.execution.stack.at(-1)?.key}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, position: current.execution.stack.at(-1)?.key, status: "snapshot-cap" },
          isError: true,
        };
      }
      if (error instanceof SnapshotByteBudgetReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, next.execution, pendingSnapshot, false, ctx);
          return {
            content: [{ type: "text", text: `Recorded ${outcome.status}. ${byteCapPhrase(error)}; the workflow continues at ${next.execution.stack.at(-1)?.key} in a fresh session.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, position: next.execution.stack.at(-1)?.key, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession), so the transition was not committed. The run stays at ${current.execution.stack.at(-1)?.key}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, position: current.execution.stack.at(-1)?.key, status: "snapshot-byte-cap", snapshotBytes: error.bytes, snapshotBytesBudget: error.budget },
          isError: true,
        };
      }
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays at ${current.execution.stack.at(-1)?.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.adoptActive(next, ctx);
    this.suppressDelivery = rollover;
    try {
      await this.drive(next, ctx);
    } catch (error) {
      if (error instanceof SnapshotCapReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, this.state.status === "active" ? this.state.execution : next.execution, this.snapshotOf(this.state.status === "active" ? this.state : next, false), false, ctx);
          return {
            content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap during script execution; the workflow continues in a fresh session.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap during script execution; the run is paused at ${this.state.status === "active" ? this.state.execution.stack.at(-1)?.key : current.execution.stack.at(-1)?.key}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "snapshot-cap" },
          isError: true,
        };
      }
      if (error instanceof SnapshotByteBudgetReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, this.state.status === "active" ? this.state.execution : next.execution, this.snapshotOf(this.state.status === "active" ? this.state : next, false), false, ctx);
          return {
            content: [{ type: "text", text: `${byteCapPhrase(error)} during script execution; the workflow continues in a fresh session.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession) during script execution; the run is paused at ${this.state.status === "active" ? this.state.execution.stack.at(-1)?.key : current.execution.stack.at(-1)?.key}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "snapshot-byte-cap", snapshotBytes: error.bytes, snapshotBytesBudget: error.budget },
          isError: true,
        };
      }
      throw error;
    } finally {
      this.suppressDelivery = false;
    }
    return this.runTerminalExclusive(signal, () => Promise.resolve(this.transitionEpilogue(current, outcome, rollover, result.effect.kind === "stay" ? "stay" : "advance", ctx)));
  }

  /**
   * Post-drive epilogue (corr-c8): the response describes the run state after
   * this transition's own effects, sampled under the terminal lock so a
   * concurrent abort can never interleave between the sample and the text.
   */
  private transitionEpilogue(current: ActiveState, outcome: TaskOutcome, rollover: boolean, effectKind: "complete" | "advance" | "stay", ctx: UiContext): ToolResult {
    if (this.state.status !== "active") {
      if (this.lastTerminal === "aborted") return this.runEndedText(current);
      return {
        content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} completed during script execution. Its bounded summary session is being prepared.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
        terminate: true,
      };
    }
    if (rollover) {
      const active = this.state;
      this.prepareRollover(active.workflow, active.execution, this.snapshotOf(active, false), false, ctx);
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
              ? `Recorded ${outcome.status}. The run stays at ${this.state.execution.stack.at(-1)?.key}${outcome.status === "blocked" ? " and waits for the user" : ""}; the checkpoint is saved.`
              : `Recorded ${outcome.status}. Continue at ${this.state.execution.stack.at(-1)?.key}; instructions arrive in the next message.`,
        },
      ],
      details: { workflow: this.state.workflow.name, runId: this.state.execution.runId, position: this.state.execution.stack.at(-1)?.key, status: outcome.status === "blocked" ? "blocked" : "active" },
    };
  }

  private async drive(active: ActiveState, ctx: UiContext, rerun = false): Promise<Execution> {
    return driveRun(this as unknown as CoordinatorInternals, active, ctx, rerun);
  }

  /**
   * Stop the run in memory when a terminal commit fails (C10). A user-visible
   * failed abort must leave nothing dispatchable: the in-memory run goes idle
   * even though the terminal record failed to persist.
   */
  private stopLocalRun(run: ActiveState, ctx: UiContext): void {
    this.state = { status: "idle" };
    this.lastTerminal = "aborted";
    this.artifactStores.delete(run.execution.runId);
    this.setTools();
    this.showStatus(ctx);
  }

  private async finishRun(current: ActiveState, ctx: UiContext, status: "completed" | "aborted", final: Execution): Promise<ToolResult> {
    if (status === "completed" && this.supportsSessionRollover(ctx)) {
      try {
        this.prepareRollover(current.workflow, final, terminalSnapshot(status, current.workflow.name, current.execution.runId, final), true, ctx);
      } catch (error) {
        return {
          content: [{ type: "text", text: `The run completed but its bounded report session could not be prepared: ${error instanceof Error ? error.message : String(error)}. Retry the transition or abort the run.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-failed" },
          isError: true,
          terminate: true,
        };
      }
      this.lastTerminal = status;
      // Terminal release (fx3): the run is over; a later store for this runId simply
      // re-creates one for the same dir, and content addressing makes that harmless.
      // Mid-run rollovers keep the entry - only terminal run states release it.
      this.artifactStores.delete(current.execution.runId);
      return {
        content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} completed. Its final report will run in a fresh bounded session.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-pending" },
        terminate: true,
      };
    }
    try {
      this.commit(terminalSnapshot(status, current.workflow.name, current.execution.runId, final), `${status === "completed" ? "completion" : "abort"} of ${current.workflow.title} run ${current.execution.runId}`);
    } catch (error) {
      if (error instanceof SnapshotCapReached) {
        const stopped = status === "aborted";
        if (stopped) this.stopLocalRun(current, ctx);
        return {
          content: [{ type: "text", text: stopped
            ? `The run was aborted, but the session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so the terminal record was not committed. The run is stopped locally and the abort is not persisted.`
            : `The run ${status}, but the session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so its terminal record was not committed. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "snapshot-cap" },
          isError: true,
        };
      }
      if (error instanceof SnapshotByteBudgetReached) {
        const stopped = status === "aborted";
        if (stopped) this.stopLocalRun(current, ctx);
        return {
          content: [{ type: "text", text: stopped
            ? `The run was aborted, but ${byteCapPhraseLower(error)} (LIMITS.snapshotBytesPerSession), so the terminal record was not committed. The run is stopped locally and the abort is not persisted.`
            : `The run ${status}, but ${byteCapPhraseLower(error)} (LIMITS.snapshotBytesPerSession), so its terminal record was not committed. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "snapshot-byte-cap", snapshotBytes: error.bytes, snapshotBytesBudget: error.budget },
          isError: true,
        };
      }
      if (!(error instanceof WorkflowStorageError)) throw error;
      const stopped = status === "aborted";
      if (stopped) this.stopLocalRun(current, ctx);
      return {
        content: [{ type: "text", text: stopped
          ? `${error.message}. The run was aborted and is stopped locally, but its terminal record failed to persist.`
          : `${error.message}. The run stays active at ${current.execution.stack.at(-1)?.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "idle" };
    this.lastTerminal = status;
    // Terminal release (fx3): the per-run ArtifactStore entry must not outlive the run
    // (about 789 B/entry on a session-lifetime Map); a later lookup re-creates it.
    // Mid-run rollovers keep the entry - only terminal run states release it.
    this.artifactStores.delete(current.execution.runId);
    this.setTools();
    this.showStatus(ctx);
    if (status === "completed") {
      try {
        await this.pi.sendUserMessage(`${summaryMessage(current.workflow, final)}\n\n${renderReportEnvelope(current.workflow, final, this.promptRead)}`, { deliverAs: "followUp" });
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

  async abort(signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
    const current = this.requireActive();
    assertNotCancelled(signal);
    await this.registry.cancelAll();
    // corr-c8: the terminal commit is serialized against the transition
    // epilogue; the re-check under the lock keeps a completed run from being
    // retro-aborted when a concurrent transition lands first.
    return this.runTerminalExclusive(signal, async () => {
      if (this.state.status !== "active") {
        return {
          content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} is no longer active; there is nothing to abort.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "not-active" },
        };
      }
      const active = this.state;
      const process = processLeafAt(active.workflow, active.execution);
      const leaf = active.execution.stack[active.execution.stack.length - 1];
      const execution = leaf && isAttemptBearingFrame(leaf)
        ? { ...active.execution, status: "aborted" as const, invocations: upsertInvocation(active.execution, leaf.key, {
            blockId: leaf.blockId,
            key: leaf.key,
            runner: process ? "process" : "agent",
            status: "canceled",
            attempt: frameAttempt(leaf),
          }) }
        : { ...active.execution, status: "aborted" as const };
      return this.finishRun(active, ctx, "aborted", execution);
    });
  }

  async retry(signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
    const current = this.requireActive();
    assertNotCancelled(signal);
    const process = processLeafAt(current.workflow, current.execution);
    const leafKeyNow = current.execution.stack.at(-1)?.key;
    const parked = leafKeyNow !== undefined && current.execution.invocations?.[leafKeyNow]?.status === "waiting";
    if (!process || !parked) {
      return {
        content: [{ type: "text", text: `workflow_retry applies only when the run is parked at a failed script step; the run is at ${current.execution.stack.at(-1)?.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, position: current.execution.stack.at(-1)?.key, status: "not-script" },
        isError: true,
      };
    }
    const next: ActiveState = { ...current, delivered: false };
    try {
      this.commit(this.snapshotOf(next, false), `retry of process ${process.key} in ${current.workflow.title} run ${current.execution.runId}`);
    } catch (error) {
      if (error instanceof SnapshotCapReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, current.execution, this.snapshotOf(current, false), false, ctx);
          return {
            content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap; the run continues in a fresh session, where you can retry process ${process.key}.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, position: current.execution.stack.at(-1)?.key, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap, so the retry was not recorded. The run stays parked at ${process.key}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, position: process.key, status: "snapshot-cap" },
          isError: true,
        };
      }
      if (error instanceof SnapshotByteBudgetReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, current.execution, this.snapshotOf(current, false), false, ctx);
          return {
            content: [{ type: "text", text: `${byteCapPhrase(error)}; the run continues in a fresh session, where you can retry process ${process.key}.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, position: process.key, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession), so the retry was not recorded. The run stays parked at ${process.key}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, position: process.key, status: "snapshot-byte-cap", snapshotBytes: error.bytes, snapshotBytesBudget: error.budget },
          isError: true,
        };
      }
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays parked at ${process.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.adoptActive(next, ctx);
    const rollover = this.supportsSessionRollover(ctx);
    this.suppressDelivery = rollover;
    try {
      await this.drive(next, ctx, true);
    } catch (error) {
      if (error instanceof SnapshotCapReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, this.state.status === "active" ? this.state.execution : current.execution, this.snapshotOf(this.state.status === "active" ? this.state : current, false), false, ctx);
          return {
            content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap during script execution; the workflow continues in a fresh session.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `The session reached its ${LIMITS.snapshotEntriesPerSession}-snapshot cap during script execution; the run is paused at ${this.state.status === "active" ? this.state.execution.stack.at(-1)?.key : process.key}. Continue in a fresh session or raise LIMITS.snapshotEntriesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "snapshot-cap" },
          isError: true,
        };
      }
      if (error instanceof SnapshotByteBudgetReached) {
        if (this.supportsSessionRollover(ctx)) {
          this.prepareRollover(current.workflow, this.state.status === "active" ? this.state.execution : current.execution, this.snapshotOf(this.state.status === "active" ? this.state : current, false), false, ctx);
          return {
            content: [{ type: "text", text: `${byteCapPhrase(error)} during script execution; the workflow continues in a fresh session.` }],
            details: { workflow: current.workflow.name, runId: current.execution.runId, status: "rollover-pending" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `${byteCapPhrase(error)} (LIMITS.snapshotBytesPerSession) during script execution; the run is paused at ${this.state.status === "active" ? this.state.execution.stack.at(-1)?.key : process.key}. Continue in a fresh session or raise LIMITS.snapshotBytesPerSession.` }],
          details: { workflow: current.workflow.name, runId: current.execution.runId, status: "snapshot-byte-cap", snapshotBytes: error.bytes, snapshotBytesBudget: error.budget },
          isError: true,
        };
      }
      throw error;
    } finally {
      this.suppressDelivery = false;
    }
    if (this.state.status !== "active") {
      return {
        content: [{ type: "text", text: `Retried process ${process.key}; ${current.workflow.title} run ${current.execution.runId} completed. A summary request arrives in the next message.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
        terminate: true,
      };
    }
    const leafKey = this.state.execution.stack.at(-1)?.key;
    if (rollover) {
      const active = this.state;
      this.prepareRollover(active.workflow, active.execution, this.snapshotOf(active, false), false, ctx);
      return {
        content: [{ type: "text", text: `Retried process ${process.key}. The workflow will continue at ${leafKey} in a fresh session.` }],
        details: { workflow: active.workflow.name, runId: active.execution.runId, position: leafKey, status: "rollover-pending" },
        terminate: true,
      };
    }
    const parkedNow = leafKey !== undefined && this.state.execution.invocations?.[leafKey]?.status === "waiting";
    const failureSummary = parkedNow && leafKey !== undefined ? this.state.execution.checkpoints[leafKey]?.summary : undefined;
    return {
      content: [{ type: "text", text: parkedNow
        ? `Retried process ${process.key}; it failed again: ${failureSummary ?? "see the checkpoint"}. The run stays parked at ${leafKey}. Fix the cause, call workflow_retry again, or workflow_abort.`
        : `Retried process ${process.key}. The run stopped at ${leafKey}.` }],
      details: { workflow: this.state.workflow.name, runId: this.state.execution.runId, position: leafKey, status: parkedNow ? "parked" : "active" },
    };
  }

  async performRollover(transferId: string, ctx: ExtensionCommandContext): Promise<void> {
    await performRolloverNow(this as unknown as CoordinatorInternals, transferId, ctx);
  }

  restoreRun(ctx: UiContext): void {
    const branch = ctx.sessionManager?.getBranch() ?? [];
    this.snapshotEntries = countSnapshotEntries(branch);
    this.snapshotBytes = snapshotBytesInBranch(branch);
    const pendingTransfer = preparedTransfer(branch);
    if (pendingTransfer) {
      this.state = { status: "rollover-pending", transfer: pendingTransfer.transfer };
      this.isolationRunId = pendingTransfer.transfer.runId;
      ctx.ui.notify(`Following workflow run \`${pendingTransfer.transfer.runId}\` to its bounded child session.`, "info");
      this.pi.sendUserMessage(`/${ROLLOVER_COMMAND} ${pendingTransfer.transfer.transferId}`, { expandPromptTemplates: true });
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
    if (snapshot.status !== "active") return;
    const workflow = this.workflows.find((item) => item.name === snapshot.workflow);
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
      expectedDigest = this.frozenFor(workflow).digest;
    } catch (error) {
      const detail = error instanceof WorkflowCompileError ? error.detail : error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.execution.runId}\`: its definition no longer compiles (${detail}). Restore the files, then start the workflow again.`, "warning");
      return;
    }
    if (expectedDigest && snapshot.execution.definitionDigest !== undefined && snapshot.execution.definitionDigest !== expectedDigest) {
      ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.execution.runId}\`: the workflow changed since the run started (definition digest mismatch). Start the workflow again.`, "warning");
      return;
    }
    this.freezePromptSources(workflow);
    const state: ActiveState = {
      status: "active",
      workflow,
      execution: migrated.execution,
      delivered: snapshot.delivered,
    };
    this.baselineTools = snapshot.baselineTools
      ? [...snapshot.baselineTools]
      : this.knownTools().filter((name) => !this.isWorkflowTool(name));
    this.isolationRunId = state.execution.runId;
    this.adoptActive(state, ctx);
    ctx.ui.notify(`Resumed ${workflow.title} run \`${state.execution.runId}\` at ${state.execution.stack.at(-1)?.key}.`, "info");
    void this.drive(state, ctx);
  }

  handleSessionStart(ctx: UiContext): { unknownTools: string[] } {
    this.state = { status: "idle" };
    this.baselineTools = null;
    this.isolationRunId = undefined;
    this.snapshotEntries = 0;
    this.snapshotBytes = 0;
    this.snapshotByteLog.length = 0;
    this.delivery.reset();
    this.lastTerminal = undefined;
    void this.registry.cancelAll();
    this.notifyCtx.current = ctx;
    const sessionDir = ctx.sessionManager?.getSessionDir?.();
    this.runtimeArtifactRoot = sessionDir && isAbsolute(sessionDir) ? sessionDir : undefined;
    const available = new Set(this.knownTools());
    const unknownTools: string[] = [];
    for (const workflow of this.workflows) {
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
    this.setTools();
    sweepWorkflowArtifacts(this.workflows, this.defaultArtifactRoot ?? this.runtimeArtifactRoot, undefined, (message, level) => ctx.ui.notify(message, level));
    this.restoreRun(ctx);
    this.setTools();
    this.showStatus(ctx);
    return { unknownTools };
  }

  async handleAgentSettled(ctx: UiContext): Promise<void> {
    this.notifyCtx.current = ctx;
    await this.deliverPending();
    if (this.state.status === "idle") this.isolationRunId = undefined;
  }

  handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (this.state.status === "active") {
      const store = this.artifactStoreFor(this.state.workflow, this.state.execution.runId);
      const guide = renderPositionEnvelope(this.state.workflow, this.state.execution, this.promptRead, refLoaderFor(store), this.activeToolsFor(this.state));
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


function blocksWithTools(workflow: Workflow): readonly (readonly string[])[] {
  return workflowBlocks(workflow)
    .filter((block) => block.kind === "task" && block.tools)
    .map((block) => (block as { tools: readonly string[] }).tools ?? []);
}


