import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

  pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => runtime.handleContext(event, ctx));

  pi.on("session_before_compact", (event, ctx) => runtime.handleBeforeCompact(event, ctx));
  pi.on("session_compact", (event) => runtime.handleCompact(event));
  (pi as unknown as { on(name: "session_compact_failed", handler: (event: { reason: string; errorMessage?: string; aborted: boolean }) => void): void })
    .on("session_compact_failed", (event) => runtime.handleCompactFailed(event));
}
