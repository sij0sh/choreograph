import { currentPosition } from "../engine/interpreter.ts";
import type { Execution } from "../domain/execution.ts";
import type { Workflow } from "../domain/workflow.ts";

export function desiredModel(workflow: Workflow, state: Execution): string | undefined {
  const position = currentPosition(workflow, state);
  if (!position) return workflow.model;
  if (position.type === "task" && position.task?.model) return position.task.model;
  return workflow.model;
}
