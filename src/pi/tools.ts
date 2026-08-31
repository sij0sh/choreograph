import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import {
  BOUNDARY_CHECKPOINT_FIELDS,
  TRANSITION_FIELDS,
  TRANSITION_SHAPE,
  type BoundaryCheckpointField,
  type TransitionField,
  type TransitionStatus,
} from "../domain/checkpoint.ts";
import type { Workflow } from "../domain/workflow.ts";
import type { RuntimeCoordinator, ToolResult } from "../runtime/coordinator.ts";
import { DEFAULT_TARGET, START_TOOL_NAME, WorkflowCompileError } from "../runtime/coordinator.ts";
import { ABORT_TOOL_NAME, RETRY_TOOL_NAME, TRANSITION_TOOL_NAME } from "../runtime/capabilities.ts";

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
          target: Type.Optional(Type.String({ maxLength: LIMITS.targetBytes, description: `Optional: the concrete subject the workflow should focus on (files, area, question, or defect); at most ${LIMITS.targetBytes} bytes. Omit or leave blank to target ${DEFAULT_TARGET}.` })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _update, ctx) {
        const workflow = byName.get(params.name);
        if (!workflow) {
          return { content: [{ type: "text", text: `Unknown workflow: ${params.name}` }], details: { workflow: params.name, status: "unknown" }, isError: true } satisfies ToolResult;
        }
        const target = typeof params.target === "string" ? params.target.trim() : DEFAULT_TARGET;
        if (Buffer.byteLength(target, "utf8") > LIMITS.targetBytes) {
          return {
            content: [{ type: "text", text: `target exceeds ${LIMITS.targetBytes} bytes; narrow it and start again. The session stays idle.` }],
            details: { workflow: params.name, status: "target-too-long" },
            isError: true,
          } satisfies ToolResult;
        }
        let run;
        try {
          run = await runtime.startWorkflow(ctx, workflow, target, signal);
        } catch (error) {
          if (error instanceof WorkflowCompileError) {
            return {
              content: [{ type: "text", text: `${error.message} The session stays idle.` }],
              details: { workflow: params.name, status: "definition-uncompilable" },
              isError: true,
            } satisfies ToolResult;
          }
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


  const checkpointProperties = {
    summary: Type.String({ description: `What was done and concluded at this position; at most ${LIMITS.checkpointSummaryBytes} bytes.` }),
    evidence: Type.Optional(Type.Array(Type.String({ description: `One reference or finding; at most ${LIMITS.checkpointItemBytes} bytes each.` }), { maxItems: LIMITS.checkpointListItems, description: "Evidence references backing the summary." })),
    decisions: Type.Optional(Type.Array(Type.String({ description: `One decision; at most ${LIMITS.checkpointItemBytes} bytes each.` }), { maxItems: LIMITS.checkpointListItems, description: "Decisions taken." })),
    unknowns: Type.Optional(Type.Array(Type.String({ description: `One open question or risk; at most ${LIMITS.checkpointItemBytes} bytes each.` }), { maxItems: LIMITS.checkpointListItems, description: "Open questions or risks." })),
    data: Type.Optional(Type.Any({ description: "Structured payload; plan creation carries data.plan here. All other position-specific output lives here." })),
  } satisfies Record<BoundaryCheckpointField, TSchema>;
  const transitionProperties = {
    status: Type.Unsafe<TransitionStatus>({
      type: "string",
      enum: [...TRANSITION_SHAPE.statuses],
      description: "The outcome of the current position.",
    }),
    key: Type.String({ minLength: 1, description: "The position key this outcome applies to; copy `Position` verbatim from the instructions envelope. A key mismatch is rejected." }),
    met: Type.Optional(
      Type.Array(Type.String({ pattern: ID_PATTERN.source, description: "A criterion id matching ^[a-z][a-z0-9-]*$." }), {
        uniqueItems: true,
        description: "Criterion ids copied verbatim from the position's required criteria. A completion must list every required criterion.",
      }),
    ),
    checkpoint: Type.Object(checkpointProperties, { additionalProperties: false }),
    issues: Type.Optional(
      Type.Array(
        Type.Object(
          {
            target: Type.String({ minLength: 1, description: "The block, node, or task id the problem concerns." }),
            reason: Type.String({ minLength: 1, description: "Why the target needs work." }),
          },
          { additionalProperties: false },
        ),
        { description: "Problems found; only valid with status \"needs-work\"." },
      ),
    ),
  } satisfies Record<TransitionField, TSchema>;
  const transitionParameters = Type.Object(transitionProperties, { additionalProperties: false });
  const checkpointShape = BOUNDARY_CHECKPOINT_FIELDS
    .map((field) => `${field}${TRANSITION_SHAPE.checkpointFields[field].required ? "" : "?"}`)
    .join(", ");
  const transitionShape = TRANSITION_FIELDS
    .map((field) => field === "checkpoint"
      ? `checkpoint: { ${checkpointShape} }`
      : `${field}${TRANSITION_SHAPE.fields[field].required ? "" : "?"}`)
    .join(", ");
  pi.registerTool({
    name: TRANSITION_TOOL_NAME,
    label: "Transition workflow",
    description: [
      "Record the outcome of the current workflow position: completed (criteria met), needs-work (problems found; recovery policy decides what happens), or blocked (cannot proceed).",
      "Invoke this as a real tool call; a transition written as text or markup is not executed.",
      `Exact shape: { ${transitionShape} }. Allowed statuses: ${TRANSITION_SHAPE.statuses.join(", ")}.`,
      "Copy `met` criterion ids verbatim from the position's required criteria; list every required id on completion.",
      "Copy `key` verbatim from the position's `Position` line; an outcome is applied only to the position it names.",
      `Caps: evidence/decisions/unknowns at most ${LIMITS.checkpointListItems} items of ${LIMITS.checkpointItemBytes} bytes each; summary at most ${LIMITS.checkpointSummaryBytes / 1024} KiB; the checkpoint at most ${LIMITS.checkpointBytes / 1024} KiB.`,
      "There are no other fields; position-specific output goes inside checkpoint.data. Rejections report every violation at once.",
    ].join(" "),
    parameters: transitionParameters,
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

  pi.registerTool({
    name: RETRY_TOOL_NAME,
    label: "Retry process",
    description: "Re-run the failed script step where the workflow is parked after exhausting its retries.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _update, ctx) {
      return runtime.retry(signal, ctx);
    },
  });
}
