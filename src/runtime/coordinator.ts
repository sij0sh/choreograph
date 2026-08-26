import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { start as engineStart, currentPosition, transition as engineTransition } from "../engine/interpreter.ts";
import type { Execution } from "../domain/execution.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import { LIMITS } from "../domain/limits.ts";
import type { Issue, TaskOutcome } from "../engine/interpreter.ts";
import type { Workflow } from "../domain/workflow.ts";
import { workflowBlocks } from "../domain/workflow.ts";
import { latestSnapshot, withinMemoryBound, WorkflowStorageError, type SnapshotStore } from "../persistence/store.ts";
import { activeSnapshot, SNAPSHOT_TYPE, terminalSnapshot } from "../persistence/snapshot.ts";
import { validateAgainstWorkflow } from "../persistence/migrate.ts";
import { effectiveTools, CONTROL_TOOLS } from "./capabilities.ts";
import { controlMessage, readBlockFrom, renderPrompt, rosterPrompt, summaryMessage } from "./prompts.ts";
import { isolateWorkflowContext, type IsolatableMessage } from "./isolation.ts";
import { statusValue } from "./status.ts";
import { DeliveryCoordinator } from "./delivery.ts";


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
};

type RunState = { status: "idle" } | ActiveState;

export class RuntimeCoordinator {
  readonly workflows: readonly Workflow[];
  readonly visibleWorkflows: readonly Workflow[];
  private readonly pi: {
    getActiveTools(): string[];
    getAllTools?: () => readonly { name: string }[];
    setActiveTools(names: string[]): void;
    appendEntry(type: string, data: unknown): void;
    sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  };
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

  private notifyCtx: { current?: UiContext } = {};

  private commit(snapshot: unknown, operation: string): void {
    try {
      this.store.append(snapshot);
    } catch (cause) {
      throw new WorkflowStorageError(operation, cause);
    }
  }

  private snapshotOf(state: ActiveState | undefined, delivered: boolean): unknown {
    if (!state) return terminalSnapshot("aborted", "", "");
    this.baselineTools ??= this.captureBaseline();
    return activeSnapshot({ workflow: state.workflow.name, execution: state.execution, delivered, baselineTools: this.baselineTools });
  }

  private readonly isWorkflowTool = (name: string): boolean => [START_TOOL_NAME, ...CONTROL_TOOLS].includes(name);
  private readonly knownTools = (): string[] => this.pi.getAllTools?.().map((tool) => tool.name) ?? this.pi.getActiveTools();
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

  private showStatus(ctx: UiContext): void {
    ctx.ui.setStatus("choreograph", this.state.status === "active" ? statusValue(this.state.workflow, this.state.execution) : undefined);
  }

  private requireActive(): ActiveState {
    if (this.state.status !== "active") throw new Error("no active workflow");
    return this.state;
  }

  private async deliverPending(ctx: UiContext): Promise<void> {
    if (this.state.status !== "active" || this.state.delivered) return;
    const pending = this.state;
    const leaf = pending.execution.stack[pending.execution.stack.length - 1];
    const delivered = await this.delivery.deliver({
      runId: pending.execution.runId,
      key: leaf ? `${leaf.key}#attempt-${"attempt" in leaf ? leaf.attempt : 1}` : "start",
      message: controlMessage(pending.execution),
      isLive: () => this.state === pending,
    });
    if (delivered && this.state === pending) this.state = { ...pending, delivered: true };
  }

  private adoptActive(state: ActiveState, ctx: UiContext): void {
    this.state = state;
    this.setTools();
    this.showStatus(ctx);
  }

  async startWorkflow(ctx: UiContext, workflow: Workflow, target: string, signal?: AbortSignal): Promise<ActiveState | null> {
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
    const pendingSnapshot = activeSnapshot({ workflow: next.workflow.name, execution: next.execution, delivered: next.delivered });
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
              ? `Recorded ${raw.status}. The run stays at ${next.execution.stack.at(-1)?.key}; the checkpoint is saved.`
              : `Recorded ${raw.status}. Continue at ${next.execution.stack.at(-1)?.key}; instructions arrive in the next message.`,
        },
      ],
      details: { workflow: next.workflow.name, runId: next.execution.runId, position: next.execution.stack.at(-1)?.key, status: raw.status === "blocked" ? "blocked" : "active" },
    };
  }

  private async finishRun(current: ActiveState, ctx: UiContext, status: "completed" | "aborted"): Promise<ToolResult> {
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
    return this.finishRun(current, ctx, "aborted");
  }

  restoreRun(ctx: UiContext): void {
    const branch = ctx.sessionManager?.getBranch() ?? [];
    const snapshot = latestSnapshot(branch);
    if (!snapshot) return;
    if (snapshot.status === "invalid") {
      ctx.ui.notify(`Dropped active workflow run: malformed snapshot (${snapshot.error}). Start the workflow again.`, "warning");
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
    const state: ActiveState = {
      status: "active",
      workflow,
      execution: migrated.execution,
      delivered: snapshot.delivered,
    };
    this.baselineTools = snapshot.baselineTools
      ? [...snapshot.baselineTools]
      : this.knownTools().filter((name) => !this.isWorkflowTool(name));
    this.adoptActive(state, ctx);
    ctx.ui.notify(`Resumed ${workflow.title} run \`${state.execution.runId}\` at ${state.execution.stack.at(-1)?.key}.`, "info");
  }

  handleSessionStart(ctx: UiContext): { unknownTools: string[] } {
    this.state = { status: "idle" };
    this.baselineTools = null;
    this.delivery.reset();
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
      const guide = renderPrompt(this.state.workflow, this.state.execution, this.read);
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

