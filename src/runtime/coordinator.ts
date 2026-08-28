import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { compileWorkflow } from "../authoring/compile.ts";
import { DEFINITIONS_ENTRY_TYPE, buildGeneratedWorkflow, parseDefinitionSpec, writePromotedWorkflow, type GeneratedWorkflow, type WorkflowDefinitionSpec } from "../authoring/generated.ts";
import type { CompiledBlock, CompiledWorkflowV2 } from "../domain/compiled-workflow.ts";
import { AgentRunner, ProcessRunner } from "./runner.ts";
import { RunnerRegistry } from "./registry.ts";
import { refLoaderFor, resolveScriptInputs } from "./artifacts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import type { ArtifactSink } from "../domain/artifacts.ts";
import { processSpecOf } from "../domain/node.ts";
import { dirname, isAbsolute, resolve } from "node:path";
import { start as engineStart, currentPosition, scriptLeafAt, transition as engineTransition } from "../engine/interpreter.ts";
import { upsertInvocation, type Execution } from "../domain/execution.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { LIMITS } from "../domain/limits.ts";
import type { Issue, TaskOutcome } from "../engine/interpreter.ts";
import type { ScriptBlock, Workflow } from "../domain/workflow.ts";
import { blockOf, workflowBlocks } from "../domain/workflow.ts";
import type { NodeResult } from "./runner.ts";
import { latestSnapshot, withinMemoryBound, WorkflowStorageError, type SnapshotStore } from "../persistence/store.ts";
import { activeSnapshot, SNAPSHOT_TYPE, terminalSnapshot } from "../persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../persistence/migrate.ts";
import { effectiveTools, CONTROL_TOOLS, PROMOTE_TOOL_NAME, RUN_DEFINITION_TOOL_NAME } from "./capabilities.ts";
import { controlMessage, readBlockFrom, renderPrompt, rosterPrompt, summaryMessage } from "./prompts.ts";
import { isolateWorkflowContext, type IsolatableMessage } from "./isolation.ts";
import { statusValue } from "./status.ts";
import { DeliveryCoordinator } from "./delivery.ts";
import { EVENT_ENTRY_TYPE, RunJournal, project, summarizeProjection, type RunEvent, type RunProjection } from "./journal.ts";
import { nextTuiMode, renderEventLog, renderStatus, tuiModeFromEnv, type TuiMode } from "./tui.ts";


export const START_TOOL_NAME = "workflow_start";


export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("workflow operation cancelled");
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}

type UiContext = {
  ui: { setStatus(id: string, value: string | undefined): void; notify(message: string, level: "info" | "error" | "warning"): void };
  sessionManager?: { getBranch(): unknown[] };
};

type ActiveState = {
  status: "active";
  workflow: Workflow;
  execution: Execution;
  delivered: boolean;
  parked?: boolean;
};

type RunState = { status: "idle" } | ActiveState;

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

const defaultRead = readBlockFrom({ readFileSync });

export class RuntimeCoordinator {
  readonly workflows: readonly Workflow[];
  readonly visibleWorkflows: readonly Workflow[];
  private readonly compiledCache = new Map<string, CompiledWorkflowV2>();
  private readonly generated = new Map<string, { spec: WorkflowDefinitionSpec; built: GeneratedWorkflow }>();
  private readonly virtualInstructions = new Map<string, string>();
  readonly registry = new RunnerRegistry([new AgentRunner(), new ProcessRunner()]);
  private readonly pi: {
    getActiveTools(): string[];
    getAllTools?: () => readonly { name: string }[];
    setActiveTools(names: string[]): void;
    appendEntry(type: string, data: unknown): void;
    sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  };
  private readonly store: SnapshotStore;
  private readonly read: ReturnType<typeof readBlockFrom>;
  private readonly injectedReader: boolean;
  private readonly frozenPrompts = new Map<string, string>();
  private readonly promptRead = (path: string, label: string): string => this.frozenPrompts.get(path) ?? this.virtualInstructions.get(path) ?? this.read(path, label);
  private state: RunState = { status: "idle" };
  private baselineTools: string[] | null = null;
  private readonly delivery: DeliveryCoordinator;
  private readonly journal = new RunJournal();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private tuiMode: TuiMode = tuiModeFromEnv(process.env.CHOREOGRAPH_TUI);
  private eventsPersistWarned = false;

  constructor(pi: RuntimeCoordinator["pi"], workflows: readonly Workflow[], read: ReturnType<typeof readBlockFrom> = defaultRead) {
    this.pi = pi;
    this.workflows = workflows;
    this.visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
    this.store = {
      append: (snapshot) => this.pi.appendEntry(SNAPSHOT_TYPE, snapshot),
    };
    this.read = read;
    this.injectedReader = read !== defaultRead;
    this.delivery = new DeliveryCoordinator({
      send: async (message) => {
        await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
      },
      commitDelivered: () => this.commit(this.snapshotOf(this.state.status === "active" ? this.state : undefined, true), `delivered marker`),
      notify: (message, level) => this.notifyCtx.current?.ui.notify(message, level),
    });
  }

  private notifyCtx: { current?: UiContext } = {};

  private commit(snapshot: unknown, operation: string): void {
    try {
      this.store.append(snapshot);
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
    const compiled = this.generated.get(workflow.name)?.built.compiled ?? this.compiledFor(workflow);
    if (!compiled) return;
    const dir = dirname(workflow.overviewPath);
    const add = (ref: { path: string; content: string }): void => {
      this.frozenPrompts.set(resolve(dir, ref.path), ref.content);
    };
    add(compiled.overview);
    for (const operator of Object.values(compiled.operators)) add(operator.content);
    const visit = (block: CompiledBlock): void => {
      if (block.kind === "task") add(block.instruction);
      else if (block.kind === "sequence") for (const child of block.children) visit(child);
      else if (block.kind === "loop") visit(block.body);
    };
    visit(compiled.root);
  }

  /**
   * Compile a workflow's definition lazily and memoize it. Compilation is strict: unreadable
   * required files fail it. With the default (real-filesystem) reader a strict failure refuses
   * the run via WorkflowCompileError; only coordinators constructed with an injected reader
   * (virtual or in-memory definitions, as tests and generated workflows use) fall back to it.
   */
  private compiledFor(workflow: Workflow): CompiledWorkflowV2 | undefined {
    const cached = this.compiledCache.get(workflow.name);
    if (cached) return cached;
    const dir = dirname(workflow.overviewPath);
    let compiled: CompiledWorkflowV2;
    try {
      compiled = compileWorkflow(workflow, (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      }, dir);
    } catch (error) {
      if (!this.injectedReader) throw new WorkflowCompileError(workflow, error);
      compiled = compileWorkflow(workflow, (path) => this.read(path, "compiled definition"), dir);
    }
    this.compiledCache.set(workflow.name, compiled);
    return compiled;
  }

  private clipReason(value: string | undefined): string {
    let clipped = value ?? "unknown";
    while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > 256) clipped = clipped.slice(0, -16);
    return clipped;
  }

  /**
   * Append one lifecycle event to the bounded journal and persist it
   * best-effort. Observability must never fail the run itself.
   */
  private record(event: RunEvent): void {
    this.journal.append(event);
    try {
      this.pi.appendEntry(EVENT_ENTRY_TYPE, event);
    } catch (error) {
      if (!this.eventsPersistWarned) {
        this.eventsPersistWarned = true;
        this.notifyCtx.current?.ui.notify(`Run-event persistence failed; the TUI falls back to in-memory events: ${error instanceof Error ? error.message : String(error)}.`, "warning");
      }
    }
  }

  /** Record an agent node start at most once per position/attempt, even if delivery retries. */
  private syncInvocations(runId: string, previous: Execution | undefined, next: Execution): void {
    const before = previous?.invocations ?? {};
    const after = next.invocations ?? {};
    const settled: string[] = [];
    const started: string[] = [];
    for (const key of Object.keys(after)) {
      const current = after[key]!;
      const prior = before[key];
      if (current.status === "running") {
        if (!prior || prior.status !== "running" || prior.attempt !== current.attempt) started.push(key);
        continue;
      }
      if (!prior || prior.status !== current.status) settled.push(key);
    }
    for (const key of settled) {
      const current = after[key]!;
      if (current.status === "succeeded") this.record({ type: "node-succeeded", runId, at: this.now(), key });
      else if (current.status === "waiting") {
        const reason = next.checkpoints[key]?.summary ?? previous?.checkpoints[key]?.summary;
        this.record({ type: "node-waiting", runId, at: this.now(), key, reason: this.clipReason(reason) });
      } else if (current.status === "canceled") {
        this.record({ type: "node-canceled", runId, at: this.now(), key });
      }
    }
    for (const key of started) {
      const current = after[key]!;
      const prior = before[key];
      if (prior && current.attempt > prior.attempt) {
        this.record({ type: "retry-scheduled", runId, at: this.now(), key, attempt: current.attempt });
      }
      this.record({ type: "node-started", runId, at: this.now(), key, runner: current.runner, attempt: current.attempt });
    }
  }

  /** Best-effort stdout/stderr log artifacts; failures never block the run. */
  private publishLogs(sink: ArtifactSink, exit: { readonly stdout: string; readonly stderr: string }): void {
    try {
      if (exit.stdout) sink.publishText("stdout", exit.stdout);
      if (exit.stderr) sink.publishText("stderr", exit.stderr);
    } catch {
      // The store is diagnostic; a storage failure must not fail the script.
    }
  }

  private projectionFor(runId: string): RunProjection | undefined {
    return project(this.journal.all.filter((event) => event.runId === runId));
  }

  /**
   * The run's artifact store, rooted under the workflow directory so retention stays per-run.
   * Workflows without a real directory on disk (synthetic or virtual definitions) keep the
   * inline-checkpoint behavior.
   */
  private artifactStoreFor(workflow: Workflow, runId: string): ArtifactStore | undefined {
    const cached = this.artifactStores.get(runId);
    if (cached) return cached;
    const dir = dirname(workflow.overviewPath);
    if (!isAbsolute(dir) || !existsSync(dir)) return undefined;
    const store = ArtifactStore.forRun(dir, runId);
    if (!store) return undefined;
    this.artifactStores.set(runId, store);
    return store;
  }

  private registerGenerated(entry: { spec: WorkflowDefinitionSpec; built: GeneratedWorkflow }): void {
    this.generated.set(entry.built.workflow.name, entry);
    for (const [path, content] of Object.entries(entry.built.instructions)) this.virtualInstructions.set(path, content);
  }

  private persistDefinition(spec: WorkflowDefinitionSpec): void {
    try {
      this.pi.appendEntry(DEFINITIONS_ENTRY_TYPE, spec);
    } catch {
      // Best effort: without the entry, restoring this run reports the
      // workflow as missing instead of failing later with a digest mismatch.
    }
  }

  private restoreDefinitions(branch: readonly unknown[]): void {
    for (const entry of branch) {
      const typed = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (typed.type !== "custom" || typed.customType !== DEFINITIONS_ENTRY_TYPE) continue;
      try {
        const spec = parseDefinitionSpec(typed.data);
        this.registerGenerated({ spec, built: buildGeneratedWorkflow(spec) });
      } catch {
        // Tolerant: definitions from a newer engine or malformed entries are
        // skipped so they never block session restore.
      }
    }
  }

  private replayJournal(branch: readonly unknown[]): void {
    for (const entry of branch) {
      const typed = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (typed.type === "custom" && typed.customType === EVENT_ENTRY_TYPE) this.journal.appendParsed(typed.data);
    }
  }

  cycleTuiMode(ctx: UiContext): TuiMode {
    this.tuiMode = nextTuiMode(this.tuiMode);
    this.showStatus(ctx);
    return this.tuiMode;
  }

  inspect(): { mode: TuiMode; projection: RunProjection | undefined; events: readonly string[] } | undefined {
    if (this.state.status !== "active") return undefined;
    const active: ActiveState = this.state;
    const events = this.journal.all.filter((event) => event.runId === active.execution.runId);
    return {
      mode: this.tuiMode,
      projection: project(events),
      events: renderEventLog(events, 8),
    };
  }

  private snapshotOf(state: ActiveState | undefined, delivered: boolean): unknown {
    if (!state) return terminalSnapshot("aborted", "", "");
    this.baselineTools ??= this.captureBaseline();
    return activeSnapshot({ workflow: state.workflow.name, execution: state.execution, delivered, baselineTools: this.baselineTools, parked: state.parked });
  }

  private readonly isWorkflowTool = (name: string): boolean => [START_TOOL_NAME, RUN_DEFINITION_TOOL_NAME, PROMOTE_TOOL_NAME, ...CONTROL_TOOLS].includes(name);
  private readonly knownTools = (): string[] => this.pi.getAllTools?.().map((tool) => tool.name) ?? this.pi.getActiveTools();
  private readonly captureBaseline = (): string[] => this.pi.getActiveTools().filter((name) => !this.isWorkflowTool(name));

  private activeToolsFor(state: RunState): string[] {
    this.baselineTools ??= this.captureBaseline();
    if (state.status !== "active") {
      const idle = [...this.baselineTools, RUN_DEFINITION_TOOL_NAME, PROMOTE_TOOL_NAME];
      return this.visibleWorkflows.length ? [...idle, START_TOOL_NAME] : idle;
    }
    return effectiveTools(state.workflow, state.execution, this.baselineTools);
  }

  private setTools(): void {
    this.pi.setActiveTools(this.activeToolsFor(this.state));
  }

  private showStatus(ctx: UiContext): void {
    const active = this.state.status === "active" ? this.state : undefined;
    const projection = active ? this.projectionFor(active.execution.runId) : undefined;
    ctx.ui.setStatus("choreograph", renderStatus({ mode: this.tuiMode, compact: active ? statusValue(active.workflow, active.execution) : undefined, projection }));
  }

  private requireActive(): ActiveState {
    if (this.state.status !== "active") throw new Error("no active workflow");
    return this.state;
  }

  private async deliverPending(ctx: UiContext): Promise<void> {
    if (this.state.status !== "active" || this.state.delivered) return;
    if (scriptLeafAt(this.state.workflow, this.state.execution) && !this.state.parked) return;
    const pending = this.state;
    const leaf = pending.execution.stack[pending.execution.stack.length - 1];
    const parkedScript = scriptLeafAt(pending.workflow, pending.execution);
    const message = parkedScript && pending.parked
      ? [
          controlMessage(pending.execution),
          "",
          "The script at this position failed and its retries are exhausted. The run stays parked here.",
          `Last failure: ${pending.execution.checkpoints[parkedScript.key]?.summary ?? "unavailable"}.`,
          "Fix the cause if needed, then call `workflow_retry` to re-run the script, or `workflow_abort` to stop the run.",
        ].join("\n")
      : controlMessage(pending.execution);
    const delivered = await this.delivery.deliver({
      runId: pending.execution.runId,
      key: leaf ? `${leaf.key}#attempt-${"attempt" in leaf ? leaf.attempt : 1}` : "start",
      message,
      isLive: () => this.state === pending,
    });
    if (delivered && this.state === pending) this.state = { ...pending, delivered: true };
  }

  private dispatchAgent(active: ActiveState, leaf: Execution["stack"][number]): void {
    const invocation = active.execution.invocations?.[leaf.key] ?? {
      blockId: leaf.blockId,
      key: leaf.key,
      runner: "agent" as const,
      status: "running" as const,
      attempt: "attempt" in leaf ? leaf.attempt : 1,
    };
    this.registry.dispatch(invocation, { runner: "agent", blockId: leaf.blockId });
  }

  private settleAgent(active: ActiveState, raw: { readonly status: "completed" | "needs-work" | "blocked"; readonly met?: readonly string[]; readonly checkpoint: Checkpoint; readonly issues?: readonly Issue[] }): void {
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
    this.registry.complete(key, result);
  }

  private adoptActive(state: ActiveState, ctx: UiContext): void {
    this.state = state;
    this.setTools();
    this.showStatus(ctx);
  }

  private beginRun(workflow: Workflow, target: string, ctx: UiContext): ActiveState {
    const runId = newRunId();
    const started = engineStart(workflow, { runId, target: target.trim() }, this.artifactStoreFor(workflow, runId));
    if (!started.ok) throw new Error(started.error);
    this.freezePromptSources(workflow);
    const digest = this.generated.get(workflow.name)?.built.compiled.digest ?? this.compiledFor(workflow)?.digest;
    const execution: Execution = digest ? { ...started.state, definitionDigest: digest } : started.state;
    const next: ActiveState = { status: "active", workflow, execution, delivered: false };
    this.commit(this.snapshotOf(next, false), `start of ${workflow.title} run ${next.execution.runId}`);
    this.record({ type: "run-started", runId: next.execution.runId, at: this.now(), workflow: workflow.name, target: this.clipReason(target.trim()) });
    this.syncInvocations(next.execution.runId, undefined, execution);
    this.adoptActive(next, ctx);
    ctx.ui.notify(`${workflow.title} started.`, "info");
    return next;
  }

  async startWorkflow(ctx: UiContext, workflow: Workflow, target: string, signal?: AbortSignal): Promise<ActiveState | null> {
    if (this.state.status === "active") {
      ctx.ui.notify(`${this.state.workflow.title} run ${this.state.execution.runId} is already active.`, "error");
      return null;
    }
    assertNotCancelled(signal);
    const next = this.beginRun(workflow, target, ctx);
    const finalExecution = await this.drive(next, ctx);
    return { ...next, execution: finalExecution };
  }

  /**
   * Compile a runtime-produced definition and start it. The definition is
   * ephemeral: it lives in the session registry, is frozen with the run
   * snapshot via its digest, and persists as a definition entry so a reload
   * can restore the run. It never joins the discovered roster.
   */
  async startGenerated(raw: unknown, target: string, ctx: UiContext, signal?: AbortSignal): Promise<ActiveState | null> {
    if (this.state.status === "active") {
      ctx.ui.notify(`${this.state.workflow.title} run ${this.state.execution.runId} is already active.`, "error");
      return null;
    }
    assertNotCancelled(signal);
    const spec = parseDefinitionSpec(raw);
    if (this.workflows.some((workflow) => workflow.name === spec.name)) {
      throw new Error(`workflow name "${spec.name}" is already used by a discovered workflow`);
    }
    const built = buildGeneratedWorkflow(spec);
    this.registerGenerated({ spec, built });
    this.persistDefinition(spec);
    const next = this.beginRun(built.workflow, target, ctx);
    const finalExecution = await this.drive(next, ctx);
    return { ...next, execution: finalExecution };
  }

  /**
   * Persist a generated definition as a named workflow directory under
   * workflowsRoot and validate it with the standard discovery parser.
   * Refuses unknown names, discovered-name collisions, and overwrites.
   */
  promoteDefinition(name: string, workflowsRoot: string): { directory: string; spec: WorkflowDefinitionSpec } {
    if (this.workflows.some((workflow) => workflow.name === name)) {
      throw new Error(`"${name}" is already a discovered workflow`);
    }
    const entry = this.generated.get(name);
    if (!entry) throw new Error(`no generated workflow named "${name}" exists in this session`);
    return { directory: writePromotedWorkflow(entry.spec, workflowsRoot), spec: entry.spec };
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
    const raw = params as { status: "completed" | "needs-work" | "blocked"; met?: readonly string[]; checkpoint: Checkpoint; issues?: readonly Issue[] };
    const outcome: TaskOutcome = {
      status: raw.status,
      ...(raw.met !== undefined ? { met: raw.met } : {}),
      checkpoint: raw.checkpoint,
      ...(raw.issues !== undefined ? { issues: [...raw.issues] } : {}),
    };
    const result = engineTransition(current.workflow, current.execution, { type: "outcome", outcome }, this.artifactStoreFor(current.workflow, current.execution.runId));
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Invalid transition: ${result.error}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "invalid-transition" },
        isError: true,
      };
    }
    this.syncInvocations(current.execution.runId, current.execution, result.state);
    if (result.effect.kind === "complete") {
      this.settleAgent(current, raw);
      return this.finishRun(current, ctx, "completed", result.state);
    }
    const next: ActiveState = { ...current, execution: result.state, delivered: result.effect.kind === "stay" };
    const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: next.delivered });
    if (!withinMemoryBound(pendingSnapshot)) {
      this.record({ type: "run-paused", runId: current.execution.runId, at: this.now(), reason: "memory bound" });
      return {
        content: [{ type: "text", text: `The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB; the transition was rejected. Abort the run or narrow the checkpoint data.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "memory-bound" },
        isError: true,
      };
    }
    this.settleAgent(current, raw);
    try {
      this.commit(this.snapshotOf(next, next.delivered), `transition of ${current.workflow.title} run ${current.execution.runId} to ${result.state.stack.at(-1)?.key ?? "completion"}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays at ${current.execution.stack.at(-1)?.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.adoptActive(next, ctx);
    await this.drive(next, ctx);
    if (this.state.status !== "active") {
      return {
        content: [{ type: "text", text: `${current.workflow.title} run ${current.execution.runId} completed during script execution. A summary request arrives in the next message.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
        terminate: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            result.effect.kind === "stay"
              ? `Recorded ${raw.status}. The run stays at ${this.state.execution.stack.at(-1)?.key}; the checkpoint is saved.`
              : `Recorded ${raw.status}. Continue at ${this.state.execution.stack.at(-1)?.key}; instructions arrive in the next message.`,
        },
      ],
      details: { workflow: this.state.workflow.name, runId: this.state.execution.runId, position: this.state.execution.stack.at(-1)?.key, status: raw.status === "blocked" ? "blocked" : "active" },
    };
  }

  private async drive(active: ActiveState, ctx: UiContext): Promise<Execution> {
    if (scriptLeafAt(active.workflow, active.execution) && active.parked) {
      await this.deliverPending(ctx);
      return active.execution;
    }
    return await this.driveLoop(active, ctx);
  }

  private async driveLoop(active: ActiveState, ctx: UiContext): Promise<Execution> {
    let current = active;
    let execution = active.execution;
    while (this.state === current) {
      const script = scriptLeafAt(current.workflow, current.execution);
      if (!script) {
        const agentLeaf = current.execution.stack[current.execution.stack.length - 1];
        if (agentLeaf && (agentLeaf.kind === "task" || agentLeaf.kind === "plan" || agentLeaf.kind === "node")) {
          this.dispatchAgent(current, agentLeaf);
        }
        await this.deliverPending(ctx);
        return execution;
      }
      const leaf = current.execution.stack[current.execution.stack.length - 1];
      const recorded = current.execution.invocations?.[script.key];
      
      
      const reexecution = recorded !== undefined && recorded.status !== "running";
      const attempt = reexecution ? recorded.attempt + 1 : recorded?.attempt ?? (leaf && "attempt" in leaf ? leaf.attempt : 1);
      if (reexecution) {
        this.record({ type: "retry-scheduled", runId: current.execution.runId, at: this.now(), key: script.key, attempt });
      }
      const invocation = { ...(recorded ?? { blockId: script.block.id, key: script.key, runner: "process" as const, attempt }), status: "running" as const, attempt };
      const processSpec = processSpecOf(script.block, dirname(current.workflow.overviewPath));
      const store = this.artifactStoreFor(current.workflow, current.execution.runId);
      const sink = store?.sinkFor(script.key);
      const resolved = resolveScriptInputs(
        current.workflow,
        current.execution,
        script.block.inputs,
        store ? (ref) => store.materialize(ref, processSpec.cwd) : undefined,
      );
      if (!resolved.ok) {
        this.record({ type: "node-failed", runId: current.execution.runId, at: this.now(), key: script.key, reason: this.clipReason(resolved.error) });
        ctx.ui.notify(`Script ${script.key} could not run: ${resolved.error}. The run stays at ${script.key}.`, "error");
        return execution;
      }
      if (!this.journal.all.some((event) => event.type === "node-started" && event.runId === current.execution.runId && event.key === script.key && event.attempt === invocation.attempt)) {
        this.record({ type: "node-started", runId: current.execution.runId, at: this.now(), key: script.key, runner: "process", attempt: invocation.attempt });
      }
      const result = await this.registry
        .dispatch(invocation, processSpecOf(script.block, dirname(current.workflow.overviewPath)), resolved.inputs)
        .result;
      if (this.state !== current) return execution;
      if (result.status === "canceled") {
        this.record({ type: "node-canceled", runId: current.execution.runId, at: this.now(), key: script.key });
        return execution;
      }
      if (!result.exit) {
        this.record({ type: "node-failed", runId: current.execution.runId, at: this.now(), key: script.key, reason: this.clipReason(result.reason) });
        ctx.ui.notify(`Script ${script.key} could not run: ${result.reason ?? "unknown runner error"}. The run stays at ${script.key}.`, "error");
        return execution;
      }
      const exit = result.exit;
      if (exit.cancelled) {
        this.record({ type: "node-canceled", runId: current.execution.runId, at: this.now(), key: script.key });
        return execution;
      }
      if (sink) this.publishLogs(sink, exit);
      const applied = engineTransition(current.workflow, current.execution, { type: "process-exit", key: script.key, exit, ...(sink ? { store: sink } : {}) }, store);
      if (!applied.ok) {
        this.record({ type: "node-failed", runId: current.execution.runId, at: this.now(), key: script.key, reason: this.clipReason(applied.error) });
        ctx.ui.notify(`Script result for ${script.key} could not be applied: ${applied.error}. The run stays at ${script.key}.`, "error");
        return execution;
      }
      execution = applied.state;
      this.syncInvocations(current.execution.runId, current.execution, applied.state);
      if (applied.effect.kind === "complete") {
        await this.finishRun(current, ctx, "completed", applied.state);
        return execution;
      }
      const parked = applied.effect.kind === "stay";
      if (parked && reexecution) {
        
        this.record({ type: "node-waiting", runId: current.execution.runId, at: this.now(), key: script.key, reason: this.clipReason(applied.state.checkpoints[script.key]?.summary) });
      }
      const next: ActiveState = { ...current, execution: applied.state, delivered: false, ...(parked ? { parked: true } : { parked: undefined }) };
      const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: false });
      if (!withinMemoryBound(pendingSnapshot)) {
        this.record({ type: "run-paused", runId: current.execution.runId, at: this.now(), reason: "memory bound" });
        ctx.ui.notify(`The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB after script ${script.key}; the run is paused. Abort the run or narrow the workflow outputs.`, "error");
        return execution;
      }
      try {
        this.commit(this.snapshotOf(next, false), `script ${script.key} in ${current.workflow.title} run ${current.execution.runId}`);
      } catch (error) {
        if (!(error instanceof WorkflowStorageError)) throw error;
        ctx.ui.notify(`${error.message}. The run stays at ${script.key}.`, "error");
        return execution;
      }
      this.adoptActive(next, ctx);
      if (parked) {
        await this.deliverPending(ctx);
        return execution;
      }
      current = next;
    }
    return execution;
  }

  /**
   * Project one agent outcome onto the journal: success, an accepted retry,
   * or a wait at the same position.
   */
  private async finishRun(current: ActiveState, ctx: UiContext, status: "completed" | "aborted", final: Execution): Promise<ToolResult> {
    this.record({ type: status === "completed" ? "run-completed" : "run-aborted", runId: current.execution.runId, at: this.now() });
    try {
      this.commit(terminalSnapshot(status, current.workflow.name, current.execution.runId, final), `${status === "completed" ? "completion" : "abort"} of ${current.workflow.title} run ${current.execution.runId}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays active at ${current.execution.stack.at(-1)?.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "idle" };
    this.setTools();
    this.showStatus(ctx);
    if (status === "completed") {
      try {
        await this.pi.sendUserMessage(summaryMessage(current.workflow, current.execution), { deliverAs: "followUp" });
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
    const script = scriptLeafAt(current.workflow, current.execution);
    const leaf = current.execution.stack[current.execution.stack.length - 1];
    const execution = leaf && (leaf.kind === "task" || leaf.kind === "plan" || leaf.kind === "node")
      ? { ...current.execution, status: "aborted" as const, invocations: upsertInvocation(current.execution, leaf.key, {
          blockId: leaf.blockId,
          key: leaf.key,
          runner: script ? "process" : "agent",
          status: "canceled",
          attempt: "attempt" in leaf ? leaf.attempt : 1,
        }) }
      : { ...current.execution, status: "aborted" as const };
    return this.finishRun(current, ctx, "aborted", execution);
  }

  async retry(signal: AbortSignal | undefined, ctx: UiContext): Promise<ToolResult> {
    const current = this.requireActive();
    assertNotCancelled(signal);
    const script = scriptLeafAt(current.workflow, current.execution);
    if (!script) {
      return {
        content: [{ type: "text", text: `workflow_retry applies only when the run is parked at a failed script; the run is at ${current.execution.stack.at(-1)?.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, position: current.execution.stack.at(-1)?.key, status: "not-script" },
        isError: true,
      };
    }
    const next: ActiveState = { ...current, delivered: false, parked: undefined };
    try {
      this.commit(this.snapshotOf(next, false), `retry of script ${script.key} in ${current.workflow.title} run ${current.execution.runId}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays parked at ${script.key}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.adoptActive(next, ctx);
    const finalExecution = await this.drive(next, ctx);
    if (this.state.status !== "active") {
      return {
        content: [{ type: "text", text: `Retried script ${script.key}; ${current.workflow.title} run ${current.execution.runId} completed. A summary request arrives in the next message.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "completed" },
        terminate: true,
      };
    }
    const leafKey = this.state.execution.stack.at(-1)?.key;
    const parkedNow = this.state.parked === true;
    const failureSummary = parkedNow ? this.state.execution.checkpoints[this.state.execution.stack.at(-1)!.key]?.summary : undefined;
    return {
      content: [{ type: "text", text: parkedNow
        ? `Retried script ${script.key}; it failed again: ${failureSummary ?? "see the checkpoint"}. The run stays parked at ${leafKey}. Fix the cause, call workflow_retry again, or workflow_abort.`
        : `Retried script ${script.key}. The run stopped at ${leafKey}.` }],
      details: { workflow: this.state.workflow.name, runId: this.state.execution.runId, position: leafKey, status: parkedNow ? "parked" : "active" },
    };
  }

  restoreRun(ctx: UiContext): void {
    const branch = ctx.sessionManager?.getBranch() ?? [];
    this.restoreDefinitions(branch);
    const snapshot = latestSnapshot(branch);
    if (!snapshot) return;
    if (snapshot.status === "invalid") {
      ctx.ui.notify(`Dropped active workflow run: malformed snapshot (${snapshot.error}). Start the workflow again.`, "warning");
      return;
    }
    if (snapshot.status !== "active") return;
    const workflow = this.workflows.find((item) => item.name === snapshot.workflow) ?? this.generated.get(snapshot.workflow)?.built.workflow;
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
      expectedDigest = this.generated.get(workflow.name)?.built.compiled.digest ?? this.compiledFor(workflow)?.digest;
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
    const leafScript = scriptLeafAt(workflow, migrated.execution);
    const leafKey = migrated.execution.stack[migrated.execution.stack.length - 1]?.key;
    const leafWaiting = leafScript !== undefined && leafKey !== undefined && migrated.execution.invocations?.[leafKey]?.status === "waiting";
    const state: ActiveState = {
      status: "active",
      workflow,
      execution: migrated.execution,
      delivered: snapshot.delivered,
      ...((snapshot.parked === true || leafWaiting) ? { parked: true } : {}),
    };
    this.baselineTools = snapshot.baselineTools
      ? [...snapshot.baselineTools]
      : this.knownTools().filter((name) => !this.isWorkflowTool(name));
    this.replayJournal(branch);
    this.adoptActive(state, ctx);
    this.record({ type: "run-resumed", runId: state.execution.runId, at: this.now() });
    ctx.ui.notify(`Resumed ${workflow.title} run \`${state.execution.runId}\` at ${state.execution.stack.at(-1)?.key}.`, "info");
    void this.drive(state, ctx);
  }

  handleSessionStart(ctx: UiContext): { unknownTools: string[] } {
    this.state = { status: "idle" };
    this.baselineTools = null;
    this.delivery.reset();
    void this.registry.cancelAll();
    this.notifyCtx.current = ctx;
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
    this.restoreRun(ctx);
    this.showStatus(ctx);
    return { unknownTools };
  }

  async handleAgentSettled(ctx: UiContext): Promise<void> {
    this.notifyCtx.current = ctx;
    await this.deliverPending(ctx);
  }

  handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (this.state.status === "active") {
      const store = this.artifactStoreFor(this.state.workflow, this.state.execution.runId);
      const guide = renderPrompt(this.state.workflow, this.state.execution, this.promptRead, store ? refLoaderFor(store) : undefined, this.activeToolsFor(this.state));
      return { systemPrompt: `${event.systemPrompt}\n\n${guide}` };
    }
    const roster = rosterPrompt(this.visibleWorkflows);
    return roster ? { systemPrompt: `${event.systemPrompt}\n\n${roster}` } : undefined;
  }

  handleContext<T extends IsolatableMessage>(event: { messages: readonly T[] }): { messages: T[] } | undefined {
    if (this.state.status !== "active" || !this.state.delivered) return undefined;
    const isolated = isolateWorkflowContext(event.messages, this.state.execution.runId);
    return isolated ? { messages: isolated } : undefined;
  }
}

function blocksWithTools(workflow: Workflow): readonly (readonly string[])[] {
  return workflowBlocks(workflow)
    .filter((block) => block.kind === "task" && block.tools)
    .map((block) => (block as { tools: readonly string[] }).tools ?? []);
}


