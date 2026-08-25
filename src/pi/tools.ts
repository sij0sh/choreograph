import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Workflow } from "../domain/workflow.ts";
import type { RuntimeCoordinator, ToolResult } from "../runtime/coordinator.ts";
import { ABORT_TOOL_NAME, START_TOOL_NAME, TRANSITION_TOOL_NAME } from "../runtime/coordinator.ts";

const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;

export function registerWorkflowTools(pi: ExtensionAPI, runtime: RuntimeCoordinator, workflows: readonly Workflow[]): void {
  const visible = workflows.filter((workflow) => workflow.piVisibility);
  const byName = new Map(visible.map((workflow) => [workflow.name, workflow]));

  if (visible.length) {
    pi.registerTool({
      name: START_TOOL_NAME,
      label: "Start workflow",
      description: `Start a workflow by name. Available: ${visible.map((workflow) => workflow.name).join(", ")}. Start only when the user requests one.`,
      parameters: Type.Object(
        {
          name: Type.Unsafe<string>({ type: "string", enum: visible.map((workflow) => workflow.name), description: "The workflow to start." }),
          target: Type.Optional(Type.String({ description: "Optional subject or arguments the workflow should focus on." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _update, ctx) {
        const workflow = byName.get(params.name);
        if (!workflow) {
          return { content: [{ type: "text", text: `Unknown workflow: ${params.name}` }], details: { workflow: params.name, status: "unknown" }, isError: true } satisfies ToolResult;
        }
        let run;
        try {
          run = await runtime.startWorkflow(ctx, workflow, params.target ?? "", signal);
        } catch (error) {
          if (!(error instanceof Error && error.name === "WorkflowStorageError")) throw error;
          return {
            content: [{ type: "text", text: `${error.message}. The session stays idle.` }],
            details: { workflow: params.name, status: "storage-failed" },
            isError: true,
          } satisfies ToolResult;
        }
        if (!run) {
          return { content: [{ type: "text", text: "A workflow is already active." }], details: { workflow: params.name, status: "busy" }, isError: true } satisfies ToolResult;
        }
        return {
          content: [{ type: "text", text: `${workflow.title} run ${run.execution.runId} started. Its first message arrives next.` }],
          details: { workflow: workflow.name, runId: run.execution.runId, position: run.execution.stack[run.execution.stack.length - 1]?.key, status: "active" },
          terminate: true,
        } satisfies ToolResult;
      },
    });
  }

  pi.registerTool({
    name: TRANSITION_TOOL_NAME,
    label: "Transition workflow",
    description: "Record the outcome of the current workflow position: completed (criteria met), needs-work (problems found; recovery policy decides what happens), or blocked (cannot proceed).",
    parameters: Type.Object(
      {
        status: Type.Unsafe<"completed" | "needs-work" | "blocked">({
          type: "string",
          enum: ["completed", "needs-work", "blocked"],
          description: "The outcome of the current position.",
        }),
        met: Type.Optional(Type.Array(Type.String(), { description: "Criterion ids claimed complete. A completion must list every required criterion." })),
        checkpoint: Type.Object(
          {
            summary: Type.String({ description: "What was done and concluded at this position." }),
            evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence references backing the summary." })),
            decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions taken." })),
            unknowns: Type.Optional(Type.Array(Type.String(), { description: "Open questions or risks." })),
            data: Type.Optional(Type.Any({ description: "Structured payload; plan creation carries data.plan here." })),
          },
          { additionalProperties: false },
        ),
        issues: Type.Optional(
          Type.Array(
            Type.Object(
              {
                target: Type.String({ description: "The block, node, or task id the problem concerns." }),
                reason: Type.String({ description: "Why the target needs work." }),
              },
              { additionalProperties: false },
            ),
            { description: "Problems found; only valid with status \"needs-work\"." },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      return runtime.transition(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: ABORT_TOOL_NAME,
    label: "Abort workflow",
    description: "Abort the active workflow only when the user requests it or the workflow cannot continue.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _update, ctx) {
      return runtime.abort(signal, ctx);
    },
  });
}
