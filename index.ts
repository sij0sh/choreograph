import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows } from "./manifest.ts";
import type { WorkflowDescriptor } from "./types.ts";
import { WorkflowRuntime, START_TOOL_NAME, ADVANCE_TOOL_NAME, TRANSITION_TOOL_NAME, ABORT_TOOL_NAME } from "./runtime.ts";

const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const WORKFLOWS_ROOT = join(AGENT_ROOT, "workflows");
const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;
const WORKFLOW_STORAGE_ERROR = "WorkflowStorageError";

function isStorageError(error: unknown): boolean {
  return error instanceof Error && error.name === WORKFLOW_STORAGE_ERROR;
}

function storageMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function piWorkflows(pi: ExtensionAPI, workflowsRoot: string = WORKFLOWS_ROOT): void {
  const { workflows, diagnostics } = discoverWorkflows(workflowsRoot);
  const visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
  const workflowsByName = new Map(visibleWorkflows.map((workflow) => [workflow.name, workflow]));
  const runtime = new WorkflowRuntime(pi, workflows);

  const hasLegacy = workflows.some((workflow) => !workflow.structured);
  const hasStructured = workflows.some((workflow) => workflow.structured);

  if (hasLegacy) {
    pi.registerTool({
      name: ADVANCE_TOOL_NAME,
      label: "Advance workflow",
      description: "Advance the active legacy workflow once the current step's completion criteria are met. Continues to the next step or completes the workflow after the final step.",
      parameters: NO_PARAMETERS,
      async execute(_id, _params, signal, _update, ctx) {
        return runtime.advance(signal, ctx);
      },
    });
  }

  if (hasStructured) {
    pi.registerTool({
      name: TRANSITION_TOOL_NAME,
      label: "Transition workflow",
      description: "Record the outcome of the current workflow position: pass (criteria met), blocked (cannot proceed), rework (redo a destination), or replan (regenerate the dynamic plan).",
      parameters: Type.Object(
        {
          outcome: Type.Unsafe<"pass" | "blocked" | "rework" | "replan">({
            type: "string",
            enum: ["pass", "blocked", "rework", "replan"],
            description: "The outcome of the current position.",
          }),
          met: Type.Optional(Type.Array(Type.String(), { description: "Criterion ids claimed complete. A pass must list every required criterion." })),
          checkpoint: Type.Object(
            {
              summary: Type.String({ description: "What was done and concluded at this position." }),
              evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence references backing the summary." })),
              decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions taken." })),
              unknowns: Type.Optional(Type.Array(Type.String(), { description: "Open questions or risks." })),
              data: Type.Optional(Type.Any({ description: "Structured payload; the planner pass carries data.plan here." })),
            },
            { additionalProperties: false },
          ),
          nodes: Type.Optional(Type.Array(Type.String(), { description: "Node ids to invalidate; only for a verifier rework into the executor." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _update, ctx) {
        return runtime.transition(params, signal, ctx);
      },
    });
  }

  pi.registerTool({
    name: ABORT_TOOL_NAME,
    label: "Abort workflow",
    description: "Abort the active workflow only when the user requests it or the workflow cannot continue.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _update, ctx) {
      return runtime.abort(signal, ctx);
    },
  });

  for (const workflow of workflows) {
    pi.registerCommand(workflow.name, {
      description: `${workflow.description} Optional arguments describe the target.`,
      handler: async (args, ctx) => {
        try {
          await runtime.startWorkflow(ctx, workflow, args ?? "");
        } catch (error) {
          if (!isStorageError(error)) throw error;
          ctx.ui.notify(`${storageMessage(error)}. The session stays idle.`, "error");
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
        const workflow: WorkflowDescriptor | undefined = workflowsByName.get(params.name);
        if (!workflow) {
          return { content: [{ type: "text", text: `Unknown workflow: ${params.name}` }], details: { workflow: params.name, status: "unknown" }, isError: true };
        }
        let run;
        try {
          run = await runtime.startWorkflow(ctx, workflow, params.target ?? "", signal);
        } catch (error) {
          if (!isStorageError(error)) throw error;
          return {
            content: [{ type: "text", text: `${storageMessage(error)}. The session stays idle.` }],
            details: { workflow: params.name, status: "storage-failed" },
            isError: true,
          };
        }
        if (!run) {
          return { content: [{ type: "text", text: "A workflow is already active." }], details: { workflow: params.name, status: "busy" }, isError: true };
        }
        return {
          content: [{ type: "text", text: `${workflow.title} run ${run.runId} started. Its first message arrives next.` }],
          details: { workflow: workflow.name, runId: run.runId, step: run.position.stepId, status: "active" },
          terminate: true,
        };
      },
    });
  }

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const { unknownTools, unknownModels } = runtime.handleSessionStart(ctx);
    if (unknownTools.length) ctx.ui.notify(`workflow tools name unknown tools (no effect during runs): ${unknownTools.join(", ")}`, "warning");
    if (unknownModels.length) ctx.ui.notify(`configured models are unavailable on this machine: ${unknownModels.join(", ")}`, "warning");
    if (diagnostics.length) {
      const summary = diagnostics.map((item) => `${item.path}: ${item.error}`).join("; ");
      ctx.ui.notify(`Skipped invalid workflow metadata: ${summary}`, "warning");
    }
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    await runtime.handleAgentSettled(ctx);
  });

  pi.on("before_agent_start", (event: { systemPrompt: string }) => runtime.handleBeforeAgentStart(event));
}
