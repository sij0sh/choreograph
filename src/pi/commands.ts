import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../domain/workflow.ts";
import type { RuntimeCoordinator } from "../runtime/coordinator.ts";
import { renderDetailed } from "../runtime/tui.ts";
import { ROLLOVER_COMMAND } from "../runtime/transfer.ts";

export function registerRuntimeCommands(pi: ExtensionAPI, runtime: RuntimeCoordinator): void {
  pi.registerCommand(ROLLOVER_COMMAND, {
    description: "Internal command that moves a workflow into its next bounded context epoch.",
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
  pi.registerCommand("workflow-tui", {
    description: "Cycle the workflow TUI mode (off, compact, detailed).",
    handler: async (_args, ctx) => {
      const mode = runtime.cycleTuiMode(ctx);
      ctx.ui.notify(`Workflow TUI mode: ${mode}.`, "info");
    },
  });
  pi.registerCommand("workflow-inspect", {
    description: "Show an active or completed run projection and its recent lifecycle events. Pass a run id to select history.",
    handler: async (args, ctx) => {
      const requestedRunId = (args ?? "").trim() || undefined;
      const report = runtime.inspect(requestedRunId);
      if (!report) {
        ctx.ui.notify(requestedRunId ? `No lifecycle history found for run ${requestedRunId}.` : "No workflow run history.", "info");
        return;
      }
      const summary = report.projection
        ? [...renderDetailed(report.projection), "history:", ...report.events].join("\n")
        : "No lifecycle events could be projected for this run.";
      ctx.ui.notify(`Run: ${report.runId}. TUI mode: ${report.mode}.\n${summary}`, "info");
    },
  });
}

export function registerWorkflowCommands(pi: ExtensionAPI, runtime: RuntimeCoordinator, workflows: readonly Workflow[]): void {
  for (const workflow of workflows) {
    pi.registerCommand(workflow.name, {
      description: `${workflow.description} Optional arguments describe the target.`,
      handler: async (args, ctx) => {
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
