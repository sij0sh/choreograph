import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows } from "./manifest.ts";
import type { WorkflowDescriptor } from "./types.ts";

const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const WORKFLOWS_ROOT = join(AGENT_ROOT, "workflows");
const START_TOOL_NAME = "workflow_start";
const RUN_TOOL_NAMES = ["workflow_advance", "workflow_abort"] as const;
const ALL_WORKFLOW_TOOLS = [START_TOOL_NAME, ...RUN_TOOL_NAMES] as const;
const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;
const SNAPSHOT_TYPE = "pi-workflows";

class WorkflowStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`workflow ${operation} was not committed to session storage: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowStorageError";
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("workflow operation cancelled");
}

interface ActiveRun {
  readonly workflow: WorkflowDescriptor;
  readonly runId: string;
  readonly step: number;
  readonly target: string;
}

type RunState =
  | { readonly status: "idle" }
  | { readonly status: "active"; readonly run: ActiveRun; readonly delivered: boolean };

type ActiveSnapshot = {
  readonly v: 2;
  readonly status: "active";
  readonly workflow: string;
  readonly runId: string;
  readonly step: number;
  readonly target: string;
  readonly delivered: boolean;
};

type TerminalSnapshot =
  | { readonly v: 2; readonly status: "completed"; readonly workflow: string; readonly runId: string; readonly totalSteps: number }
  | { readonly v: 2; readonly status: "aborted" };

type ParsedSnapshot = ActiveSnapshot | { readonly status: "terminal" };

function isStepIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const snapshot = data as Record<string, unknown>;
  if ((snapshot.v === 1 || snapshot.v === 2) && (snapshot.status === "aborted" || snapshot.status === "completed")) {
    return { status: "terminal" };
  }
  if (snapshot.status !== "active" || (snapshot.v !== 1 && snapshot.v !== 2)) return null;
  if (typeof snapshot.workflow !== "string" || typeof snapshot.runId !== "string") return null;
  if (!isStepIndex(snapshot.step) || typeof snapshot.target !== "string") return null;

  let delivered: boolean;
  if (snapshot.v === 2) {
    if (typeof snapshot.delivered !== "boolean") return null;
    delivered = snapshot.delivered;
  } else {
    if (typeof snapshot.deliveredStep !== "number" || !Number.isInteger(snapshot.deliveredStep)) return null;
    if (snapshot.deliveredStep !== snapshot.step && snapshot.deliveredStep !== snapshot.step - 1) return null;
    delivered = snapshot.deliveredStep === snapshot.step;
  }

  return {
    v: 2,
    status: "active",
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    step: snapshot.step,
    target: snapshot.target,
    delivered,
  };
}

function latestSnapshot(branch: readonly unknown[]): ParsedSnapshot | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) return parseSnapshot(entry.data);
  }
  return null;
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function stepRefAt(workflow: WorkflowDescriptor, step: number): string {
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

function promptFor(run: ActiveRun): string {
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

function rosterPrompt(visible: readonly WorkflowDescriptor[]): string {
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

export default function piWorkflows(pi: ExtensionAPI, workflowsRoot: string = WORKFLOWS_ROOT): void {
  const { workflows, diagnostics } = discoverWorkflows(workflowsRoot);
  const visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
  const allWorkflowsByName = new Map(workflows.map((workflow) => [workflow.name, workflow]));
  const workflowsByName = new Map(visibleWorkflows.map((workflow) => [workflow.name, workflow]));
  let state: RunState = { status: "idle" };
  let baselineTools: string[] | null = null;
  let sentDelivery: { runId: string; step: number } | null = null;

  const isWorkflowTool = (name: string): boolean => (ALL_WORKFLOW_TOOLS as readonly string[]).includes(name);
  const captureBaseline = (): string[] => pi.getActiveTools().filter((name) => !isWorkflowTool(name));

  function setRunTools(): void {
    baselineTools ??= captureBaseline();
    const legal = state.status === "active" ? state.run.workflow.legalTools : undefined;
    const base = legal ? baselineTools.filter((name) => legal.has(name)) : baselineTools;
    pi.setActiveTools([...base, ...RUN_TOOL_NAMES]);
  }

  function setIdleTools(): void {
    baselineTools ??= captureBaseline();
    pi.setActiveTools(visibleWorkflows.length ? [...baselineTools, START_TOOL_NAME] : [...baselineTools]);
  }

  function showStatus(ctx: ExtensionContext): void {
    const run = state.status === "active" ? state.run : null;
    ctx.ui.setStatus("pi-workflows", run ? `${run.workflow.name} ${run.step}/${run.workflow.steps.length}` : undefined);
  }

  function requireActiveState(): Extract<RunState, { status: "active" }> {
    if (state.status !== "active") throw new Error("no active workflow");
    return state;
  }

  function appendCommitted(snapshot: ActiveSnapshot | TerminalSnapshot, operation: string): void {
    try {
      pi.appendEntry(SNAPSHOT_TYPE, snapshot);
    } catch (cause) {
      throw new WorkflowStorageError(operation, cause);
    }
  }

  async function deliverPending(ctx: ExtensionContext): Promise<void> {
    if (state.status !== "active" || state.delivered) return;
    const pending = state;
    const delivery = { runId: pending.run.runId, step: pending.run.step };
    if (sentDelivery?.runId !== delivery.runId || sentDelivery.step !== delivery.step) {
      let message: string;
      try {
        message = transitionMessage(pending.run);
      } catch (error) {
        ctx.ui.notify(`Workflow content unreadable: ${error instanceof Error ? error.message : String(error)}. Restore the file to retry delivery, or abort the run.`, "error");
        return;
      }
      try {
        await pi.sendUserMessage(message, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Workflow follow-up failed: ${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`, "error");
        return;
      }
      sentDelivery = delivery;
    }
    if (state !== pending) return;
    try {
      appendCommitted(activeSnapshot(pending.run, true), `delivered marker for ${pending.run.workflow.title} run ${pending.run.runId}`);
    } catch (error) {
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`, "error");
      return;
    }
    if (state === pending) state = { ...pending, delivered: true };
  }

  function restoreRun(ctx: ExtensionContext): void {
    const snapshot = latestSnapshot(ctx.sessionManager.getBranch());
    if (!snapshot || snapshot.status === "terminal") return;
    const workflow = allWorkflowsByName.get(snapshot.workflow);
    if (!workflow) {
      ctx.ui.notify(`Cannot resume ${snapshot.workflow} run: that workflow no longer exists.`, "warning");
      return;
    }
    if (snapshot.step > workflow.steps.length) {
      ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.runId}\`: step ${snapshot.step} of ${workflow.steps.length} no longer exists.`, "warning");
      return;
    }
    state = { status: "active", run: { workflow, runId: snapshot.runId, step: snapshot.step, target: snapshot.target }, delivered: snapshot.delivered };
    setRunTools();
    ctx.ui.notify(`Resumed ${workflow.title} run \`${snapshot.runId}\` at step ${snapshot.step}/${workflow.steps.length}.`, "info");
  }

  async function startWorkflow(ctx: ExtensionContext, workflow: WorkflowDescriptor, target: string, signal?: AbortSignal): Promise<ActiveRun | null> {
    if (state.status === "active") {
      ctx.ui.notify(`${state.run.workflow.title} run ${state.run.runId} is already active.`, "error");
      return null;
    }
    assertNotCancelled(signal);
    const run: ActiveRun = { workflow, runId: newRunId(), step: 1, target: target.trim() };
    appendCommitted(activeSnapshot(run, false), `start of ${workflow.title} run ${run.runId}`);
    state = { status: "active", run, delivered: false };
    setRunTools();
    showStatus(ctx);
    ctx.ui.notify(`${workflow.title} started.`, "info");
    await deliverPending(ctx);
    return run;
  }

  pi.registerTool({
    name: "workflow_advance",
    label: "Advance workflow",
    description: "Advance the active workflow once the current step's completion criteria are met. Continues to the next step or completes the workflow after the final step.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _update, ctx) {
      const current = requireActiveState();
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
          appendCommitted(terminal, `completion of ${workflow.title} run ${runId}`);
        } catch (error) {
          if (!(error instanceof WorkflowStorageError)) throw error;
          return {
            content: [{ type: "text", text: `${error.message}. The run stays active on its final step.` }],
            details: { workflow: workflow.name, runId, step, status: "storage-failed" },
            isError: true,
          };
        }
        state = { status: "idle" };
        setIdleTools();
        showStatus(ctx);
        try {
          await pi.sendUserMessage(summaryMessage(current.run), { deliverAs: "followUp" });
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
        appendCommitted(activeSnapshot(run, false), `advance of ${workflow.title} run ${runId} to step ${run.step}`);
      } catch (error) {
        if (!(error instanceof WorkflowStorageError)) throw error;
        return {
          content: [{ type: "text", text: `${error.message}. The run stays active on step ${step}.` }],
          details: { workflow: workflow.name, runId, step, status: "storage-failed" },
          isError: true,
        };
      }
      state = { status: "active", run, delivered: false };
      showStatus(ctx);
      await deliverPending(ctx);
      return {
        content: [{ type: "text", text: `Step ${step} complete. Advancing to ${stepRefAt(workflow, run.step)}. Its instructions arrive in the next message.` }],
        details: { workflow: workflow.name, runId, step: run.step, status: "active" },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "workflow_abort",
    label: "Abort workflow",
    description: "Abort the active workflow only when the user requests it or the workflow cannot continue.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _update, ctx) {
      const current = requireActiveState().run;
      assertNotCancelled(signal);
      try {
        appendCommitted({ v: 2, status: "aborted" }, `abort of ${current.workflow.title} run ${current.runId}`);
      } catch (error) {
        if (!(error instanceof WorkflowStorageError)) throw error;
        return {
          content: [{ type: "text", text: `${error.message}. The run stays active.` }],
          details: { workflow: current.workflow.name, runId: current.runId, step: current.step, status: "storage-failed" },
          isError: true,
        };
      }
      state = { status: "idle" };
      setIdleTools();
      showStatus(ctx);
      return {
        content: [{ type: "text", text: `${current.workflow.title} run ${current.runId} aborted.` }],
        details: { workflow: current.workflow.name, runId: current.runId, step: current.step, status: "aborted" },
        terminate: true,
      };
    },
  });

  for (const workflow of workflows) {
    pi.registerCommand(workflow.name, {
      description: `${workflow.description} Optional arguments describe the target.`,
      handler: async (args, ctx) => {
        try {
          await startWorkflow(ctx, workflow, args ?? "");
        } catch (error) {
          if (!(error instanceof WorkflowStorageError)) throw error;
          ctx.ui.notify(`${error.message}. The session stays idle.`, "error");
        }
      },
    });
  }

  if (visibleWorkflows.length) {
    pi.registerTool({
      name: START_TOOL_NAME,
      label: "Start workflow",
      description: `Start a workflow by name. Available: ${visibleWorkflows.map((workflow) => workflow.name).join(", ")}. Start only when the user requests one.`,
      parameters: Type.Object(
        {
          name: Type.Unsafe<string>({ type: "string", enum: visibleWorkflows.map((workflow) => workflow.name), description: "The workflow to start." }),
          target: Type.Optional(Type.String({ description: "Optional subject or arguments the workflow should focus on." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _update, ctx) {
        const workflow = workflowsByName.get(params.name);
        if (!workflow) {
          return { content: [{ type: "text", text: `Unknown workflow: ${params.name}` }], details: { workflow: params.name, status: "unknown" }, isError: true };
        }
        let run: ActiveRun | null;
        try {
          run = await startWorkflow(ctx, workflow, params.target ?? "", signal);
        } catch (error) {
          if (!(error instanceof WorkflowStorageError)) throw error;
          return {
            content: [{ type: "text", text: `${error.message}. The session stays idle.` }],
            details: { workflow: params.name, status: "storage-failed" },
            isError: true,
          };
        }
        if (!run) {
          return { content: [{ type: "text", text: "A workflow is already active." }], details: { workflow: params.name, status: "busy" }, isError: true };
        }
        return {
          content: [{ type: "text", text: `${workflow.title} run ${run.runId} started. Its first message arrives next.` }],
          details: { workflow: workflow.name, runId: run.runId, step: run.step, status: "active" },
          terminate: true,
        };
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    state = { status: "idle" };
    baselineTools = null;
    const available = new Set(pi.getActiveTools());
    const unknownTools = workflows.flatMap((workflow) =>
      workflow.legalTools ? [...workflow.legalTools].filter((tool) => !available.has(tool)).map((tool) => `${workflow.name}: ${tool}`) : [],
    );
    setIdleTools();
    restoreRun(ctx);
    showStatus(ctx);
    if (unknownTools.length) ctx.ui.notify(`legalTools name unknown tools (no effect during runs): ${unknownTools.join(", ")}`, "warning");
    if (diagnostics.length) {
      const summary = diagnostics.map((item) => `${item.path}: ${item.error}`).join("; ");
      ctx.ui.notify(`Skipped invalid workflow metadata: ${summary}`, "warning");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await deliverPending(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (state.status === "active") return { systemPrompt: `${event.systemPrompt}\n\n${promptFor(state.run)}` };
    const roster = rosterPrompt(visibleWorkflows);
    return roster ? { systemPrompt: `${event.systemPrompt}\n\n${roster}` } : undefined;
  });
}
