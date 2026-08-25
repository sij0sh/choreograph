import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { start as engineStart, currentPosition, transition as engineTransition } from "../engine/interpreter.ts";
import type { Execution } from "../domain/execution.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { validateCheckpoint } from "../domain/checkpoint.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import type { Issue, TaskOutcome } from "../engine/interpreter.ts";
import type { Workflow } from "../domain/workflow.ts";
import { workflowBlocks } from "../domain/workflow.ts";
import { latestSnapshot, WorkflowStorageError, type SnapshotStore } from "../persistence/store.ts";
import { activeSnapshot, SNAPSHOT_TYPE, terminalSnapshot } from "../persistence/snapshot.ts";
import { withinMemoryBound } from "../persistence/codec.ts";
import { validateAgainstWorkflow } from "../persistence/migrate.ts";
import { effectiveTools, CONTROL_TOOLS, TRANSITION_TOOL_NAME, ABORT_TOOL_NAME } from "./capabilities.ts";
import { desiredModel } from "./models.ts";
import { controlMessage, readBlockFrom, renderPrompt, rosterPrompt, summaryMessage } from "./prompts.ts";
import { statusValue } from "./status.ts";
import { DeliveryCoordinator } from "./delivery.ts";

export { TRANSITION_TOOL_NAME, ABORT_TOOL_NAME };
export const START_TOOL_NAME = "workflow_start";
export const RUN_TOOLS = CONTROL_TOOLS;

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
  model?: { provider?: string; id?: string };
  modelRegistry?: { find(provider: string, modelId: string): unknown };
  setModel?: (model: unknown) => Promise<boolean>;
};

export interface ExtensionContextLike extends UiContext {}

type ActiveState = {
  status: "active";
  workflow: Workflow;
  execution: Execution;
  delivered: boolean;
  restoreModel?: string;
};

type RunState = { status: "idle" } | ActiveState;

export interface TransitionRequest {
  readonly status: "completed" | "needs-work" | "blocked";
  readonly met: readonly string[];
  readonly checkpoint: Checkpoint;
  readonly issues?: readonly Issue[];
}

export function parseTransitionRequest(params: unknown): TransitionRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("transition must be an object");
  const raw = params as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["status", "met", "checkpoint", "issues"].includes(key)) throw new Error(`unknown transition field: ${key}`);
  }
  if (raw.status !== "completed" && raw.status !== "needs-work" && raw.status !== "blocked") {
    throw new Error("status must be completed, needs-work, or blocked");
  }
  if (raw.met !== undefined && !Array.isArray(raw.met)) throw new Error("met must be a list of criterion ids");
  const met = (raw.met ?? []).map((value, index) => {
    const id = typeof value === "string" ? value : "";
    if (!ID_PATTERN.test(id)) throw new Error(`met[${index}] must match ^[a-z][a-z0-9-]*$`);
    return id;
  });
  if (new Set(met).size !== met.length) throw new Error("met must not contain duplicates");
  if (raw.checkpoint === undefined) throw new Error("checkpoint is required");
  const checkpoint = validateCheckpoint(raw.checkpoint, "checkpoint");
  let issues: Issue[] | undefined;
  if (raw.issues !== undefined) {
    if (!Array.isArray(raw.issues)) throw new Error("issues must be a list");
    issues = raw.issues.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`issues[${index}] must be an object`);
      const issue = value as Record<string, unknown>;
      for (const key of Object.keys(issue)) {
        if (!["target", "reason"].includes(key)) throw new Error(`issues[${index}].${key} is not an accepted field`);
      }
      if (typeof issue.target !== "string" || !issue.target.trim()) throw new Error(`issues[${index}].target must be non-empty`);
      if (typeof issue.reason !== "string" || !issue.reason.trim()) throw new Error(`issues[${index}].reason must be non-empty`);
      return { target: issue.target, reason: issue.reason };
    });
  }
  return { status: raw.status, met, checkpoint, ...(issues ? { issues } : {}) };
}

export class RuntimeCoordinator {
  readonly workflows: readonly Workflow[];
  readonly visibleWorkflows: readonly Workflow[];
  private readonly pi: { getActiveTools(): string[]; setActiveTools(names: string[]): void; appendEntry(type: string, data: unknown): void; sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }): void };
  private readonly store: SnapshotStore;
  private readonly read: ReturnType<typeof readBlockFrom>;
  private state: RunState = { status: "idle" };
  private baselineTools: string[] | null = null;
  private readonly delivery: DeliveryCoordinator;

  constructor(pi: RuntimeCoordinator["pi"], workflows: readonly Workflow[], read: ReturnType<typeof readBlockFrom> = readBlockFrom({ readFileSync })) {
    this.pi = pi;
    this.workflows = workflows;
    this.visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
    this.store = {
      append: (snapshot) => this.pi.appendEntry(SNAPSHOT_TYPE, snapshot),
    };
    this.read = read;
    this.delivery = new DeliveryCoordinator({
      send: async (message) => {
        await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
      },
      commitDelivered: () => this.commit(this.snapshotOf(this.state.status === "active" ? this.state : undefined, true), `delivered marker`),
      notify: (message, level) => this.notifyCtx.current?.ui.notify(message, level),
    });
  }

  private notifyCtx: { current?: ExtensionContextLike } = {};

  private commit(snapshot: unknown, operation: string): void {
    try {
      this.store.append(snapshot);
    } catch (cause) {
      throw new WorkflowStorageError(operation, cause);
    }
  }

  private snapshotOf(state: ActiveState | undefined, delivered: boolean): unknown {
    if (!state) return terminalSnapshot("aborted", "", "");
    return activeSnapshot({ workflow: state.workflow.name, execution: state.execution, delivered, ...(state.restoreModel !== undefined ? { restoreModel: state.restoreModel } : {}) });
  }

  private readonly isWorkflowTool = (name: string): boolean => [START_TOOL_NAME, ...RUN_TOOLS].includes(name);
  private readonly captureBaseline = (): string[] => this.pi.getActiveTools().filter((name) => !this.isWorkflowTool(name));

  private activeToolsFor(state: RunState): string[] {
    this.baselineTools ??= this.captureBaseline();
    if (state.status !== "active") {
      return this.visibleWorkflows.length ? [...this.baselineTools, START_TOOL_NAME] : [...this.baselineTools];
    }
    return effectiveTools(state.workflow, state.execution, this.baselineTools);
  }

  private setTools(): void {
    this.pi.setActiveTools(this.activeToolsFor(this.state));
  }

  private showStatus(ctx: ExtensionContextLike): void {
    ctx.ui.setStatus("choreograph", this.state.status === "active" ? statusValue(this.state.workflow, this.state.execution) : undefined);
  }

  private requireActive(): ActiveState {
    if (this.state.status !== "active") throw new Error("no active workflow");
    return this.state;
  }

  private async applyModelFor(state: ActiveState, ctx: ExtensionContextLike): Promise<void> {
    const selector = desiredModel(state.workflow, state.execution);
    if (selector === undefined) return;
    const registry = ctx.modelRegistry;
    if (!registry || typeof registry.find !== "function") return;
    const [provider, modelId] = selector.split("/");
    const model = registry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`Configured model ${selector} is unavailable; keeping the current model.`, "warning");
      return;
    }
    if (state.restoreModel === undefined) {
      const current = ctx.model;
      if (current?.provider && current?.id) state.restoreModel = `${current.provider}/${current.id}`;
    }
    const setModel = ctx.setModel;
    if (!setModel) return;
    let applied = false;
    try {
      applied = await setModel(model);
    } catch {
      applied = false;
    }
    if (!applied) ctx.ui.notify(`Could not switch to model ${selector}; keeping the current model.`, "warning");
  }

  private async restoreSessionModel(state: ActiveState, ctx: ExtensionContextLike): Promise<void> {
    if (state.restoreModel === undefined) return;
    const registry = ctx.modelRegistry;
    const setModel = ctx.setModel;
    if (!registry || typeof registry.find !== "function" || !setModel) return;
    const [provider, modelId] = state.restoreModel.split("/");
    const model = registry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`Cannot restore session model ${state.restoreModel}; keeping the current model.`, "warning");
      return;
    }
    let restored = false;
    try {
      restored = await setModel(model);
    } catch {
      restored = false;
    }
    if (!restored) ctx.ui.notify(`Could not restore session model ${state.restoreModel}; keeping the current model.`, "warning");
  }

  private async deliverPending(ctx: ExtensionContextLike): Promise<void> {
    if (this.state.status !== "active" || this.state.delivered) return;
    const pending = this.state;
    const delivered = await this.delivery.deliver({
      runId: pending.execution.runId,
      key: pending.execution.stack[pending.execution.stack.length - 1]?.key ?? "start",
      message: controlMessage(pending.execution),
      isLive: () => this.state === pending,
      beforeSend: () => this.applyModelFor(pending, ctx),
    });
    if (delivered && this.state === pending) this.state = { ...pending, delivered: true };
  }

  private adoptActive(state: ActiveState, ctx: ExtensionContextLike): void {
    this.state = state;
    this.setTools();
    this.showStatus(ctx);
  }

  async startWorkflow(ctx: ExtensionContextLike, workflow: Workflow, target: string, signal?: AbortSignal): Promise<ActiveState | null> {
    if (this.state.status === "active") {
      ctx.ui.notify(`${this.state.workflow.title} run ${this.state.execution.runId} is already active.`, "error");
      return null;
    }
    assertNotCancelled(signal);
    const started = engineStart(workflow, { runId: newRunId(), target: target.trim() });
    if (!started.ok) throw new Error(started.error);
    const next: ActiveState = { status: "active", workflow, execution: started.state, delivered: false };
    this.commit(this.snapshotOf(next, false), `start of ${workflow.title} run ${next.execution.runId}`);
    this.adoptActive(next, ctx);
    ctx.ui.notify(`${workflow.title} started.`, "info");
    await this.deliverPending(ctx);
    return next;
  }

  async transition(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContextLike): Promise<ToolResult> {
    const current = this.requireActive();
    assertNotCancelled(signal);
    if (!current.delivered) {
      return {
        content: [{ type: "text", text: `Cannot transition \`${current.execution.stack.at(-1)?.key}\` before its instructions are delivered. They arrive as the next message; finish the current reply first.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "delivery-pending" },
        isError: true,
      };
    }
    let request: TransitionRequest;
    try {
      request = parseTransitionRequest(params);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Invalid transition: ${error instanceof Error ? error.message : String(error)}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "invalid-request" },
        isError: true,
      };
    }
    const outcome: TaskOutcome =
      request.status === "completed"
        ? { status: "completed", ...(request.met.length ? { met: request.met } : {}), checkpoint: request.checkpoint }
        : request.status === "needs-work"
          ? { status: "needs-work", checkpoint: request.checkpoint, ...(request.issues ? { issues: request.issues } : {}) }
          : { status: "blocked", checkpoint: request.checkpoint };
    const result = engineTransition(current.workflow, current.execution, { type: "outcome", outcome });
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Invalid transition: ${result.error}.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "invalid-transition" },
        isError: true,
      };
    }
    if (result.effect.kind === "complete") {
      return this.finishRun(current, ctx, "completed");
    }
    const next: ActiveState = { ...current, execution: result.state, delivered: result.effect.kind === "stay" };
    const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: next.delivered, ...(next.restoreModel !== undefined ? { restoreModel: next.restoreModel } : {}) });
    if (!withinMemoryBound(pendingSnapshot)) {
      return {
        content: [{ type: "text", text: `The run's persisted state would exceed ${LIMITS.memoryBytes / 1024} KiB; the transition was rejected. Abort the run or narrow the checkpoint data.` }],
        details: { workflow: current.workflow.name, runId: current.execution.runId, status: "memory-bound" },
        isError: true,
      };
    }
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
    if (result.effect.kind === "deliver") await this.deliverPending(ctx);
    return {
      content: [
        {
          type: "text",
          text:
            result.effect.kind === "stay"
              ? `Recorded ${request.status}. The run stays at ${next.execution.stack.at(-1)?.key}; the checkpoint is saved.`
              : `Recorded ${request.status}. Continue at ${next.execution.stack.at(-1)?.key}; instructions arrive in the next message.`,
        },
      ],
      details: { workflow: next.workflow.name, runId: next.execution.runId, position: next.execution.stack.at(-1)?.key, status: request.status === "blocked" ? "blocked" : "active" },
    };
  }

  private async finishRun(current: ActiveState, ctx: ExtensionContextLike, status: "completed" | "aborted"): Promise<ToolResult> {
    try {
      this.commit(terminalSnapshot(status, current.workflow.name, current.execution.runId), `${status === "completed" ? "completion" : "abort"} of ${current.workflow.title} run ${current.execution.runId}`);
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
    await this.restoreSessionModel(current, ctx);
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

  async abort(signal: AbortSignal | undefined, ctx: ExtensionContextLike): Promise<ToolResult> {
    const current = this.requireActive();
    assertNotCancelled(signal);
    return this.finishRun(current, ctx, "aborted");
  }

  restoreRun(ctx: ExtensionContextLike): void {
    const branch = ctx.sessionManager?.getBranch() ?? [];
    const snapshot = latestSnapshot(branch);
    if (!snapshot) return;
    if (snapshot.status === "invalid") {
      ctx.ui.notify(`Dropped active workflow run: malformed snapshot (${snapshot.error}). Start the workflow again.`, "warning");
      return;
    }
    if (snapshot.status === "legacy") {
      ctx.ui.notify(`Dropped ${snapshot.workflow} run from a previous engine version. Start the workflow again.`, "warning");
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
      ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.runId}\`: ${migrated.error}.`, "warning");
      return;
    }
    const state: ActiveState = {
      status: "active",
      workflow,
      execution: migrated.execution,
      delivered: snapshot.delivered,
      ...(snapshot.restoreModel !== undefined ? { restoreModel: snapshot.restoreModel } : {}),
    };
    this.adoptActive(state, ctx);
    ctx.ui.notify(`Resumed ${workflow.title} run \`${snapshot.runId}\` at ${state.execution.stack.at(-1)?.key}.`, "info");
    void this.applyModelFor(state, ctx);
  }

  handleSessionStart(ctx: ExtensionContextLike): { unknownTools: string[]; unknownModels: string[] } {
    this.state = { status: "idle" };
    this.baselineTools = null;
    this.delivery.reset();
    this.notifyCtx.current = ctx;
    const available = new Set(this.pi.getActiveTools());
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
    const registry = ctx.modelRegistry;
    const unknownModels: string[] = [];
    if (registry && typeof registry.find === "function") {
      for (const workflow of this.workflows) {
        const selectors = new Set([workflow.model, ...blocksWithModels(workflow)].filter((selector): selector is string => Boolean(selector)));
        for (const selector of selectors) {
          const [provider, modelId] = selector.split("/");
          if (!registry.find(provider, modelId)) unknownModels.push(`${workflow.name}: ${selector}`);
        }
      }
    }
    this.setTools();
    this.restoreRun(ctx);
    this.showStatus(ctx);
    return { unknownTools, unknownModels };
  }

  async handleAgentSettled(ctx: ExtensionContextLike): Promise<void> {
    this.notifyCtx.current = ctx;
    await this.deliverPending(ctx);
  }

  handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (this.state.status === "active") {
      const guide = renderPrompt(this.state.workflow, this.state.execution, this.read);
      return { systemPrompt: `${event.systemPrompt}\n\n${guide}` };
    }
    const roster = rosterPrompt(this.visibleWorkflows);
    return roster ? { systemPrompt: `${event.systemPrompt}\n\n${roster}` } : undefined;
  }
}

function blocksWithTools(workflow: Workflow): readonly (readonly string[])[] {
  return workflowBlocks(workflow)
    .filter((block) => block.kind === "task" && block.tools)
    .map((block) => (block as { tools: readonly string[] }).tools ?? []);
}

function blocksWithModels(workflow: Workflow): readonly string[] {
  return workflowBlocks(workflow)
    .filter((block) => block.kind === "task" && block.model)
    .map((block) => (block as { model?: string }).model ?? "");
}
