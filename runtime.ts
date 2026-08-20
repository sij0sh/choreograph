import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDescriptor } from "./types.ts";
import { latestSnapshot, SNAPSHOT_TYPE, type ActiveSnapshot, type TerminalSnapshot } from "./state.ts";

export const START_TOOL_NAME = "workflow_start";
export const RUN_TOOL_NAMES = ["workflow_advance", "workflow_abort"] as const;
export const ALL_WORKFLOW_TOOLS = [START_TOOL_NAME, ...RUN_TOOL_NAMES] as const;

export class WorkflowStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`workflow ${operation} was not committed to session storage: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowStorageError";
  }
}

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("workflow operation cancelled");
}

export interface ActiveRun {
  readonly workflow: WorkflowDescriptor;
  readonly runId: string;
  readonly step: number;
  readonly target: string;
}

type RunState =
  | { readonly status: "idle" }
  | { readonly status: "active"; readonly run: ActiveRun; readonly delivered: boolean };

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function stepRefAt(workflow: WorkflowDescriptor, step: number): string {
  return `step ${step} (${workflow.steps[step - 1].label})`;
}

function readBlock(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${label} unavailable: ${detail}. Restore the file or abort the run.`;
  }
}

export function promptFor(run: ActiveRun): string {
  return [
    "# Active workflow",
    `Workflow: ${run.workflow.title} (\`${run.workflow.name}\`)`,
    `Run: \`${run.runId}\` - Step: ${run.step}/${run.workflow.steps.length} (${stepRefAt(run.workflow, run.step)})`,
    "",
    "You are mid-workflow. Treat the instructions below as authoritative.",
    "",
    "## Controls",
    "- `workflow_advance` - advance once the current step's completion criteria are met. The workflow completes after the final step.",
    "- `workflow_abort` - stop the run when the user asks or it cannot continue. To restart, abort then start the workflow again.",
    "",
    "## Workflow overview",
    readBlock(run.workflow.overviewPath, "Workflow overview"),
    "## Current step instructions",
    readBlock(run.workflow.steps[run.step - 1].path, "Step instructions"),
  ].join("\n\n");
}

export function rosterPrompt(visible: readonly WorkflowDescriptor[]): string {
  if (!visible.length) return "";
  return [
    "# Available workflows",
    "Start a listed workflow with the `workflow_start` tool only when the user asks. The user can also start one with its slash command (`/name target`).",
    ...visible.map((workflow) => `- \`${workflow.name}\`: ${workflow.description}`),
  ].join("\n");
}

function transitionMessage(run: ActiveRun): string {
  const start = run.step === 1;
  const lines = start
    ? [`Start ${run.workflow.title} run \`${run.runId}\` at ${stepRefAt(run.workflow, run.step)}.`, "Follow the workflow overview and step instructions below semantically."]
    : [`Continue ${run.workflow.title} run \`${run.runId}\` at ${stepRefAt(run.workflow, run.step)}.`, "Follow the step instructions below semantically."];
  if (start) {
    if (run.target) lines.push(`Target: ${run.target}`);
    lines.push("## Workflow overview", readFileSync(run.workflow.overviewPath, "utf8"));
  }
  lines.push("## Step instructions", readFileSync(run.workflow.steps[run.step - 1].path, "utf8"));
  return lines.join("\n\n");
}

function summaryMessage(run: ActiveRun): string {
  return [
    `${run.workflow.title} run \`${run.runId}\` is complete: all ${run.workflow.steps.length} steps advanced.`,
    "Summarize what was done, the key findings and recommendations, the risks or open issues, and suggested next steps.",
  ].join("\n");
}

function activeSnapshot(run: ActiveRun, delivered: boolean): ActiveSnapshot {
  return { v: 2, status: "active", workflow: run.workflow.name, runId: run.runId, step: run.step, target: run.target, delivered };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}

/** Session-scoped workflow state machine, decoupled from tool registration. */
export class WorkflowRuntime {
  readonly workflows: readonly WorkflowDescriptor[];
  readonly visibleWorkflows: readonly WorkflowDescriptor[];
  private readonly pi: { getActiveTools(): string[]; setActiveTools(names: string[]): void; appendEntry(type: string, data: unknown): void; sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }): void };
  private state: RunState = { status: "idle" };
  private baselineTools: string[] | null = null;
  private sentDelivery: { runId: string; step: number } | null = null;

  constructor(pi: WorkflowRuntime["pi"], workflows: readonly WorkflowDescriptor[]) {
    this.pi = pi;
    this.workflows = workflows;
    this.visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
  }

  private readonly isWorkflowTool = (name: string): boolean => (ALL_WORKFLOW_TOOLS as readonly string[]).includes(name);
  private readonly captureBaseline = (): string[] => this.pi.getActiveTools().filter((name) => !this.isWorkflowTool(name));

  private setRunTools(): void {
    this.baselineTools ??= this.captureBaseline();
    const legal = this.state.status === "active" ? this.state.run.workflow.legalTools : undefined;
    const base = legal ? this.baselineTools.filter((name) => legal.has(name)) : this.baselineTools;
    this.pi.setActiveTools([...base, ...RUN_TOOL_NAMES]);
  }

  private setIdleTools(): void {
    this.baselineTools ??= this.captureBaseline();
    this.pi.setActiveTools(this.visibleWorkflows.length ? [...this.baselineTools, START_TOOL_NAME] : [...this.baselineTools]);
  }

  private showStatus(ctx: ExtensionContext): void {
    const run = this.state.status === "active" ? this.state.run : null;
    ctx.ui.setStatus("pi-workflows", run ? `${run.workflow.name} ${run.step}/${run.workflow.steps.length}` : undefined);
  }

  private requireActiveState(): Extract<RunState, { status: "active" }> {
    if (this.state.status !== "active") throw new Error("no active workflow");
    return this.state;
  }

  private appendCommitted(snapshot: ActiveSnapshot | TerminalSnapshot, operation: string): void {
    try {
      this.pi.appendEntry(SNAPSHOT_TYPE, snapshot);
    } catch (cause) {
      throw new WorkflowStorageError(operation, cause);
    }
  }

  private async deliverPending(ctx: ExtensionContext): Promise<void> {
    if (this.state.status !== "active" || this.state.delivered) return;
    const pending = this.state;
    const delivery = { runId: pending.run.runId, step: pending.run.step };
    if (this.sentDelivery?.runId !== delivery.runId || this.sentDelivery.step !== delivery.step) {
      let message: string;
      try {
        message = transitionMessage(pending.run);
      } catch (error) {
        ctx.ui.notify(`Workflow content unreadable: ${error instanceof Error ? error.message : String(error)}. Restore the file to retry delivery, or abort the run.`, "error");
        return;
      }
      try {
        await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Workflow follow-up failed: ${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`, "error");
        return;
      }
      this.sentDelivery = delivery;
    }
    if (this.state !== pending) return;
    try {
      this.appendCommitted(activeSnapshot(pending.run, true), `delivered marker for ${pending.run.workflow.title} run ${pending.run.runId}`);
    } catch (error) {
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`, "error");
      return;
    }
    if (this.state === pending) this.state = { ...pending, delivered: true };
  }

  private restoreRun(ctx: ExtensionContext): void {
    const snapshot = latestSnapshot(ctx.sessionManager.getBranch());
    if (!snapshot || snapshot.status === "terminal") return;
    const workflow = this.workflows.find((item) => item.name === snapshot.workflow);
    if (!workflow) {
      ctx.ui.notify(`Cannot resume ${snapshot.workflow} run: that workflow no longer exists.`, "warning");
      return;
    }
    if (snapshot.step > workflow.steps.length) {
      ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.runId}\`: step ${snapshot.step} of ${workflow.steps.length} no longer exists.`, "warning");
      return;
    }
    this.state = { status: "active", run: { workflow, runId: snapshot.runId, step: snapshot.step, target: snapshot.target }, delivered: snapshot.delivered };
    this.setRunTools();
    ctx.ui.notify(`Resumed ${workflow.title} run \`${snapshot.runId}\` at step ${snapshot.step}/${workflow.steps.length}.`, "info");
  }

  async startWorkflow(ctx: ExtensionContext, workflow: WorkflowDescriptor, target: string, signal?: AbortSignal): Promise<ActiveRun | null> {
    if (this.state.status === "active") {
      ctx.ui.notify(`${this.state.run.workflow.title} run ${this.state.run.runId} is already active.`, "error");
      return null;
    }
    assertNotCancelled(signal);
    const run: ActiveRun = { workflow, runId: newRunId(), step: 1, target: target.trim() };
    this.appendCommitted(activeSnapshot(run, false), `start of ${workflow.title} run ${run.runId}`);
    this.state = { status: "active", run, delivered: false };
    this.setRunTools();
    this.showStatus(ctx);
    ctx.ui.notify(`${workflow.title} started.`, "info");
    await this.deliverPending(ctx);
    return run;
  }

  async advance(signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    const current = this.requireActiveState();
    const { workflow, runId, step, target } = current.run;
    assertNotCancelled(signal);
    if (!current.delivered) {
      return {
        content: [{ type: "text", text: `Cannot advance ${stepRefAt(workflow, step)} before its instructions are delivered.` }],
        details: { workflow: workflow.name, runId, step, status: "delivery-pending" },
        isError: true,
      };
    }
    if (step >= workflow.steps.length) {
      const terminal: TerminalSnapshot = { v: 2, status: "completed", workflow: workflow.name, runId, totalSteps: workflow.steps.length };
      try {
        this.appendCommitted(terminal, `completion of ${workflow.title} run ${runId}`);
      } catch (error) {
        if (!(error instanceof WorkflowStorageError)) throw error;
        return {
          content: [{ type: "text", text: `${error.message}. The run stays active on its final step.` }],
          details: { workflow: workflow.name, runId, step, status: "storage-failed" },
          isError: true,
        };
      }
      this.state = { status: "idle" };
      this.setIdleTools();
      this.showStatus(ctx);
      try {
        await this.pi.sendUserMessage(summaryMessage(current.run), { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Workflow summary request failed: ${error instanceof Error ? error.message : String(error)}.`, "error");
      }
      return {
        content: [{ type: "text", text: `${workflow.title} run ${runId} completed. A summary request arrives in the next message.` }],
        details: { workflow: workflow.name, runId, step, status: "completed" },
        terminate: true,
      };
    }
    const run: ActiveRun = { workflow, runId, step: step + 1, target };
    try {
      this.appendCommitted(activeSnapshot(run, false), `advance of ${workflow.title} run ${runId} to step ${run.step}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays active on step ${step}.` }],
        details: { workflow: workflow.name, runId, step, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "active", run, delivered: false };
    this.showStatus(ctx);
    await this.deliverPending(ctx);
    return {
      content: [{ type: "text", text: `Step ${step} complete. Advancing to ${stepRefAt(workflow, run.step)}. Its instructions arrive in the next message.` }],
      details: { workflow: workflow.name, runId, step: run.step, status: "active" },
      terminate: true,
    };
  }

  async abort(signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    const current = this.requireActiveState().run;
    assertNotCancelled(signal);
    try {
      this.appendCommitted({ v: 2, status: "aborted" }, `abort of ${current.workflow.title} run ${current.runId}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays active.` }],
        details: { workflow: current.workflow.name, runId: current.runId, step: current.step, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "idle" };
    this.setIdleTools();
    this.showStatus(ctx);
    return {
      content: [{ type: "text", text: `${current.workflow.title} run ${current.runId} aborted.` }],
      details: { workflow: current.workflow.name, runId: current.runId, step: current.step, status: "aborted" },
      terminate: true,
    };
  }

  handleSessionStart(ctx: ExtensionContext): { unknownTools: string[] } {
    this.state = { status: "idle" };
    this.baselineTools = null;
    const available = new Set(this.pi.getActiveTools());
    const unknownTools = this.workflows.flatMap((workflow) =>
      workflow.legalTools ? [...workflow.legalTools].filter((tool) => !available.has(tool)).map((tool) => `${workflow.name}: ${tool}`) : [],
    );
    this.setIdleTools();
    this.restoreRun(ctx);
    this.showStatus(ctx);
    return { unknownTools };
  }

  async handleAgentSettled(ctx: ExtensionContext): Promise<void> {
    await this.deliverPending(ctx);
  }

  handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (this.state.status === "active") return { systemPrompt: `${event.systemPrompt}\n\n${promptFor(this.state.run)}` };
    const roster = rosterPrompt(this.visibleWorkflows);
    return roster ? { systemPrompt: `${event.systemPrompt}\n\n${roster}` } : undefined;
  }
}
