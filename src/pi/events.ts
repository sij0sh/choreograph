import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDiagnostic } from "../authoring/parser.ts";
import type { RuntimeCoordinator } from "../runtime/coordinator.ts";

export function registerLifecycleHandlers(pi: ExtensionAPI, runtime: RuntimeCoordinator, diagnostics: readonly WorkflowDiagnostic[]): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const { unknownTools } = runtime.handleSessionStart(ctx);
    if (unknownTools.length) ctx.ui.notify(`workflow tools name unknown tools (no effect during runs): ${unknownTools.join(", ")}`, "warning");
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
