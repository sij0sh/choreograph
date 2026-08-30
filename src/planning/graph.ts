import type { PlanExecution } from "../domain/execution.ts";
import type { PlanNode } from "./schema.ts";
import { completedPlanNodeOf } from "../domain/artifacts.ts";

export function firstIncompleteNode(execution: PlanExecution): PlanNode | undefined {
  return execution.plan.nodes.find((node) => completedPlanNodeOf(execution, node.id) === undefined);
}
