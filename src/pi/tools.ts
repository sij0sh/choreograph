import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import type { Workflow } from "../domain/workflow.ts";
import type { RuntimeCoordinator, ToolResult } from "../runtime/coordinator.ts";
import { START_TOOL_NAME, WorkflowCompileError } from "../runtime/coordinator.ts";
import { ABORT_TOOL_NAME, HANDOFF_READ_TOOL_NAME, PROMOTE_TOOL_NAME, RETRY_TOOL_NAME, RUN_DEFINITION_TOOL_NAME, TRANSITION_TOOL_NAME } from "../runtime/capabilities.ts";

const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;

interface RawRecord { [key: string]: unknown }

function asRecord(value: unknown): RawRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : undefined;
}

const CHECKPOINT_FIELDS = new Set(["summary", "evidence", "decisions", "unknowns", "data", "skipped"]);








export function normalizeTransitionArguments(args: unknown): Record<string, unknown> {
  const input = asRecord(args);
  if (!input) return (args ?? {}) as Record<string, unknown>;
  const out: RawRecord = { ...input };

  
  for (const wrapper of ["outcome", "result"] as const) {
    const inner = asRecord(out[wrapper]);
    if (inner && out.checkpoint === undefined && out.status === undefined) {
      delete out[wrapper];
      for (const [key, value] of Object.entries(inner)) {
        if (out[key] === undefined) out[key] = value;
      }
    } else {
      delete out[wrapper];
    }
  }

  
  if (out.status === undefined && typeof out.outcomeStatus === "string") out.status = out.outcomeStatus;
  delete out.outcomeStatus;
  const checkpoint = asRecord(out.checkpoint);
  if (checkpoint) {
    const nested: RawRecord = { ...checkpoint };
    if (out.status === undefined && typeof nested.status === "string") {
      out.status = nested.status;
      delete nested.status;
    }
    if (out.met === undefined && nested.met !== undefined) {
      out.met = nested.met;
      delete nested.met;
    }
    if (out.issues === undefined && nested.issues !== undefined) {
      out.issues = nested.issues;
      delete nested.issues;
    }
    const data = asRecord(nested.data);
    if (data) {
      const liftIfShaped = (field: "met" | "issues", isShaped: (value: unknown) => boolean): void => {
        if (out[field] === undefined && data[field] !== undefined && isShaped(data[field])) {
          out[field] = data[field];
          delete data[field];
          if (Object.keys(data).length === 0) delete nested.data;
        }
      };
      liftIfShaped("met", (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string"));
      liftIfShaped("issues", (value) =>
        Array.isArray(value) &&
        value.every((entry) => {
          const issue = asRecord(entry);
          return issue !== undefined && typeof issue.target === "string" && typeof issue.reason === "string";
        }));
    }
    
    const stray = Object.keys(nested).filter((key) => !CHECKPOINT_FIELDS.has(key));
    if (stray.length > 0) {
      const data = asRecord(nested.data) ?? {};
      const dataOut: RawRecord = { ...data };
      for (const key of stray) {
        if (dataOut[key] === undefined) dataOut[key] = nested[key];
        delete nested[key];
      }
      nested.data = dataOut;
    }
    if (typeof nested.summary !== "string" || !nested.summary.trim()) {
      if (nested.data !== undefined) {
        const derived = JSON.stringify(nested.data) ?? "";
        nested.summary = derived.length > 512 ? `${derived.slice(0, 509)}...` : derived;
      }
    }
    out.checkpoint = nested;
  }

  
  if (typeof out.met === "string") {
    out.met = out.met.split(/[\s,]+/).filter((part) => part.length > 0);
  }
  if (Array.isArray(out.met)) {
    out.met = out.met.map((entry) => {
      if (typeof entry !== "string") return entry;
      const trimmed = entry.trim();
      return ID_PATTERN.test(trimmed) ? trimmed : trimmed.replaceAll("_", "-").toLowerCase();
    });
  }
  return out;
}

export function registerWorkflowTools(pi: ExtensionAPI, runtime: RuntimeCoordinator, workflows: readonly Workflow[], workflowsRoot: string): void {
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
          target: Type.Optional(Type.String({ maxLength: 4096, description: "Required in practice: the concrete subject the workflow should focus on (files, area, question, or defect); at most 4,096 bytes. Calls with a blank target are rejected." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _update, ctx) {
        const workflow = byName.get(params.name);
        if (!workflow) {
          return { content: [{ type: "text", text: `Unknown workflow: ${params.name}` }], details: { workflow: params.name, status: "unknown" }, isError: true } satisfies ToolResult;
        }
        const target = typeof params.target === "string" ? params.target.trim() : "";
        if (!target) {
          return {
            content: [{ type: "text", text: `A workflow needs a non-empty target. Name the concrete subject to work on (files, area, question, or defect) and retry.` }],
            details: { workflow: params.name, status: "missing-target" },
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

  pi.registerTool({
    name: RUN_DEFINITION_TOOL_NAME,
    label: "Run workflow definition",
    description: [
      "Start a runtime-generated workflow from a bounded inline definition.",
      "Exact shape: { name, title?, description, steps: [{ id, instruction, done? }] }.",
      "Ids are kebab-case; steps carry their full instruction text; `done` lists that step's completion criteria.",
      `The definition is validated strictly and started immediately; its first message arrives next. At most ${LIMITS.generatedSteps} steps and ${LIMITS.generatedDefinitionBytes / 1000} KB total.`,
      "Use it only when the user asks for a workflow that does not exist on disk; prefer `workflow_start` for known workflows.",
    ].join(" "),
    parameters: Type.Object(
      {
        definition: Type.Any({ description: "The definition object: { name, title?, description, steps: [{ id, instruction, done? }] }." }),
        target: Type.Optional(Type.String({ maxLength: 4096, description: "Optional subject or arguments the workflow should focus on; at most 4,096 bytes." })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      let run;
      try {
        run = await runtime.startGenerated(params.definition, params.target ?? "", ctx, signal);
      } catch (error) {
        if (error instanceof Error && error.name === "WorkflowStorageError") {
          return {
            content: [{ type: "text", text: `${error.message}. The session stays idle.` }],
            details: { status: "storage-failed" },
            isError: true,
          } satisfies ToolResult;
        }
        return {
          content: [{ type: "text", text: `${error instanceof Error ? error.message : String(error)}. The definition was not started; fix it and call again.` }],
          details: { status: "definition-invalid" },
          isError: true,
        } satisfies ToolResult;
      }
      if (!run) {
        return { content: [{ type: "text", text: "A workflow is already active." }], details: { status: "busy" }, isError: true } satisfies ToolResult;
      }
      return {
        content: [{ type: "text", text: `Generated workflow ${run.workflow.name} run ${run.execution.runId} started. Its first message arrives next. Call workflow_promote to persist it on disk.` }],
        details: { workflow: run.workflow.name, runId: run.execution.runId, position: run.execution.stack[run.execution.stack.length - 1]?.key, status: "active" },
        terminate: true,
      } satisfies ToolResult;
    },
  });

  pi.registerTool({
    name: PROMOTE_TOOL_NAME,
    label: "Promote generated workflow",
    description: [
      "Persist a workflow started this session through workflow_run_definition into the workflows directory as a normal file-backed workflow.",
      "Promotion is an explicit action; it never happens automatically, refuses existing directories, and the written workflow is discovered when workflows load next.",
    ].join(" "),
    parameters: Type.Object(
      { name: Type.String({ minLength: 1, description: "The generated workflow name to promote." }) },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, _ctx) {
      try {
        const { directory } = runtime.promoteDefinition(params.name, workflowsRoot);
        return {
          content: [{ type: "text", text: `Promoted ${params.name} to ${directory}. It becomes discoverable as a file-backed workflow when workflows load next.` }],
          details: { workflow: params.name, directory, status: "promoted" },
        } satisfies ToolResult;
      } catch (error) {
        return {
          content: [{ type: "text", text: `${error instanceof Error ? error.message : String(error)}. Nothing was written.` }],
          details: { workflow: params.name, status: "promote-failed" },
          isError: true,
        } satisfies ToolResult;
      }
    },
  });

  const transitionParameters = Type.Object(
    {
      status: Type.Unsafe<"completed" | "needs-work" | "blocked">({
        type: "string",
        enum: ["completed", "needs-work", "blocked"],
        description: "The outcome of the current position.",
      }),
      met: Type.Optional(
        Type.Array(Type.String({ pattern: ID_PATTERN.source, description: "A criterion id matching ^[a-z][a-z0-9-]*$." }), {
          uniqueItems: true,
          description: "Criterion ids copied verbatim from the position's required criteria. A completion must list every required criterion.",
        }),
      ),
      checkpoint: Type.Object(
        {
          summary: Type.String({ description: `What was done and concluded at this position; at most ${LIMITS.checkpointSummaryBytes} bytes.` }),
          evidence: Type.Optional(Type.Array(Type.String({ description: `One reference or finding; at most ${LIMITS.checkpointItemBytes} bytes each.` }), { maxItems: LIMITS.checkpointListItems, description: "Evidence references backing the summary." })),
          decisions: Type.Optional(Type.Array(Type.String({ description: `One decision; at most ${LIMITS.checkpointItemBytes} bytes each.` }), { maxItems: LIMITS.checkpointListItems, description: "Decisions taken." })),
          unknowns: Type.Optional(Type.Array(Type.String({ description: `One open question or risk; at most ${LIMITS.checkpointItemBytes} bytes each.` }), { maxItems: LIMITS.checkpointListItems, description: "Open questions or risks." })),
          data: Type.Optional(Type.Any({ description: "Structured payload; plan creation carries data.plan here. All other position-specific output lives here." })),
        },
        { additionalProperties: false },
      ),
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
    },
    { additionalProperties: false },
  );

  if (typeof pi.getAllTools === "function") {
    pi.registerTool({
      name: HANDOFF_READ_TOOL_NAME,
      label: "Read workflow handoff artifact",
      description: "Read an exact handoff source artifact by its sha256 checksum. Use this only when the bounded handoff capsule refers to detail needed at the current position.",
      parameters: Type.Object(
        { checksum: Type.String({ pattern: "^sha256-[0-9a-f]{64}$", description: "Artifact checksum from the workflow handoff capsule." }) },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        return runtime.readHandoff(params.checksum);
      },
    });
  }

  pi.registerTool({
    name: TRANSITION_TOOL_NAME,
    label: "Transition workflow",
    description: [
      "Record the outcome of the current workflow position: completed (criteria met), needs-work (problems found; recovery policy decides what happens), or blocked (cannot proceed).",
      "Exact shape: { status, met?, checkpoint: { summary, evidence?, decisions?, unknowns?, data? }, issues? }.",
      "Copy `met` criterion ids verbatim from the position's required criteria; list every required id on completion.",
      `Caps: evidence/decisions/unknowns at most ${LIMITS.checkpointListItems} items of ${LIMITS.checkpointItemBytes} bytes each; summary at most ${LIMITS.checkpointSummaryBytes / 1024} KiB; the checkpoint at most ${LIMITS.checkpointBytes / 1024} KiB.`,
      "There are no other fields; position-specific output goes inside checkpoint.data. If summary is omitted but data is present, summary is derived from data. Rejections report every violation at once.",
    ].join(" "),
    prepareArguments: normalizeTransitionArguments as (args: unknown) => Static<typeof transitionParameters>,
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
    description: "Re-run the failed script step or process operator node where the workflow is parked after exhausting its retries.",
    parameters: NO_PARAMETERS,
    async execute(_id, _params, signal, _update, ctx) {
      return runtime.retry(signal, ctx);
    },
  });
}
