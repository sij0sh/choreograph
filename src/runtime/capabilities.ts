import { currentPosition } from "../engine/interpreter.ts";
import type { Execution } from "../domain/execution.ts";
import type { Workflow } from "../domain/workflow.ts";

export const TRANSITION_TOOL_NAME = "workflow_transition";
export const ABORT_TOOL_NAME = "workflow_abort";
export const CONTROL_TOOLS: readonly string[] = [TRANSITION_TOOL_NAME, ABORT_TOOL_NAME];

export function effectiveTools(workflow: Workflow, state: Execution, baseline: readonly string[]): string[] {
  let tools = [...baseline];
  if (workflow.tools) {
    const ceiling = new Set(workflow.tools);
    tools = tools.filter((name) => ceiling.has(name));
  }
  const position = currentPosition(workflow, state);
  if (position?.task?.tools) {
    const ceiling = new Set(position.task.tools);
    tools = tools.filter((name) => ceiling.has(name));
  }
  if (position?.type === "node" && position.node) {
    const operator = workflow.operators.get(position.node.operator);
    if (operator?.tools) {
      const ceiling = new Set(operator.tools);
      tools = tools.filter((name) => ceiling.has(name));
    }
  }
  return [...new Set([...tools, ...CONTROL_TOOLS])];
}
