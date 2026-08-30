import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows } from "./authoring/parser.ts";
import { RuntimeCoordinator } from "./runtime/coordinator.ts";
import { registerRuntimeCommands, registerWorkflowCommands } from "./pi/commands.ts";
import { registerLifecycleHandlers } from "./pi/events.ts";
import { registerWorkflowTools } from "./pi/tools.ts";

const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const WORKFLOWS_ROOT = join(AGENT_ROOT, "workflows");

export default function piWorkflows(pi: ExtensionAPI, workflowsRoot: string = WORKFLOWS_ROOT): void {
  const { workflows, diagnostics } = discoverWorkflows(workflowsRoot);
  const runtime = new RuntimeCoordinator(pi, workflows, undefined, join(AGENT_ROOT, "workflow-artifacts"));
  registerWorkflowTools(pi, runtime, workflows);
  registerWorkflowCommands(pi, runtime, workflows);
  registerRuntimeCommands(pi, runtime);
  registerLifecycleHandlers(pi, runtime, diagnostics);
}
