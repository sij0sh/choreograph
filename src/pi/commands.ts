import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../domain/workflow.ts";
import type { RuntimeCoordinator } from "../runtime/coordinator.ts";
import { summarizeProjection } from "../runtime/journal.ts";

export function registerRuntimeCommands(pi: ExtensionAPI, runtime: RuntimeCoordinator): void {
  pi.registerCommand("workflow-tui", {
    description: "Cycle the workflow TUI mode (off, compact, detailed).",
    handler: async (_args, ctx) => {
      const mode = runtime.cycleTuiMode(ctx);
      ctx.ui.notify(`Workflow TUI mode: ${mode}.`, "info");
    },
  });
  pi.registerCommand("workflow-inspect", {
    description: "Show the current run projection and recent lifecycle events.",
    handler: async (_args, ctx) => {
      const report = runtime.inspect();
      if (!report) {
        ctx.ui.notify("No active workflow run.", "info");
        return;
      }
      const summary = report.projection ? `${summarizeProjection(report.projection)}\n${report.events.join("\n")}` : "No lifecycle events recorded for this run.";
      ctx.ui.notify(`TUI mode: ${report.mode}.\n${summary}`, "info");
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
