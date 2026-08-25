import { currentPosition } from "../engine/interpreter.ts";
import type { Execution } from "../domain/execution.ts";
import type { Workflow } from "../domain/workflow.ts";

export function statusValue(workflow: Workflow, state: Execution): string | undefined {
  if (state.status !== "active") return undefined;
  const position = currentPosition(workflow, state);
  if (!position) return undefined;
  const where = position.key === workflow.root.id ? position.key : position.key.startsWith(`${workflow.root.id}/`) ? position.key.slice(workflow.root.id.length + 1) : position.key;
  return `${workflow.name}: ${where}`;
}
