import { currentPosition } from "../engine/position.ts";
import { processLeafAt } from "../engine/interpreter.ts";
import type { Run } from "../domain/run.ts";
import type { Workflow } from "../domain/workflow.ts";

export const TRANSITION_TOOL_NAME = "workflow_transition";
export const ABORT_TOOL_NAME = "workflow_abort";
export const RETRY_TOOL_NAME = "workflow_retry";
export const CONTROL_TOOLS: readonly string[] = [TRANSITION_TOOL_NAME, ABORT_TOOL_NAME];

export function effectiveTools(workflow: Workflow, state: Run, baseline: readonly string[]): string[] {
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
  const names = [...new Set([...tools, ...CONTROL_TOOLS])];
  if (processLeafAt(workflow, state)) names.push(RETRY_TOOL_NAME);
  return names;
}
