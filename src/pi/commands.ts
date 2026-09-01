import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../domain/workflow.ts";
import type { RuntimeCoordinator } from "../runtime/coordinator.ts";
import { parseWorkflowUiMode } from "../runtime/workflow-ui.ts";
import { LIMITS } from "../domain/limits.ts";
import { inspectWorkflow } from "./workflow-inspector.ts";
import { ROLLOVER_COMMAND } from "../runtime/transfer.ts";

export function registerRuntimeCommands(pi: ExtensionAPI, runtime: RuntimeCoordinator): void {
  pi.registerCommand("workflow-tui", {
    description: "Show or change the workflow progress view. Arguments: off, compact, detailed.",
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim().toLowerCase();
      if (!requested) {
        const mode = runtime.cycleWorkflowUiMode(ctx);
        ctx.ui.notify(`Workflow view: ${mode}.`, "info");
        return;
      }
      const mode = parseWorkflowUiMode(requested);
      if (!mode) {
        ctx.ui.notify("Usage: /workflow-tui [off|compact|detailed]", "error");
        return;
      }
      runtime.setWorkflowUiMode(mode, ctx);
      ctx.ui.notify(`Workflow view: ${mode}.`, "info");
    },
  });

  pi.registerCommand("workflow-inspect", {
    description: "Open a snapshot panel of the active workflow run.",
    handler: async (_args, ctx) => {
      await inspectWorkflow(runtime, ctx);
    },
  });

  pi.registerCommand(ROLLOVER_COMMAND, {
    description: "Internal command that moves a workflow into its next bounded child session.",
    handler: async (args, ctx) => {
      const transferId = (args ?? "").trim();
      if (!transferId) {
        ctx.ui.notify(`Usage: /${ROLLOVER_COMMAND} <transfer-id>`, "error");
        return;
      }
      try {
        await runtime.performRollover(transferId, ctx);
      } catch (error) {
        ctx.ui.notify(`Workflow rollover failed: ${error instanceof Error ? error.message : String(error)}. Run /${ROLLOVER_COMMAND} ${transferId} to retry.`, "error");
      }
    },
  });
}

export function registerWorkflowCommands(pi: ExtensionAPI, runtime: RuntimeCoordinator, workflows: readonly Workflow[]): void {
  for (const workflow of workflows) {
    pi.registerCommand(workflow.name, {
      description: `${workflow.description} Optional arguments describe the target.`,
      handler: async (args, ctx) => {
        const target = (args ?? "").trim();
        if (Buffer.byteLength(target, "utf8") > LIMITS.targetBytes) {
          ctx.ui.notify(`target exceeds ${LIMITS.targetBytes} bytes; narrow it and start again. The session stays idle.`, "error");
          return;
        }
        try {
          await runtime.startWorkflow(ctx, workflow, args ?? "");
        } catch (error) {
          if (!(error instanceof Error && error.name === "WorkflowStorageError")) throw error;
          ctx.ui.notify(`${error.message}. The session stays idle.`, "error");
        }
      },
    });
  }
}
