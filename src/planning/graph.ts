import type { PlanExecution } from "../domain/execution.ts";
import type { DynamicPlan, PlanNode } from "./schema.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";

export function firstIncompleteNode(execution: PlanExecution): PlanNode | undefined {
  return execution.plan.nodes.find((node) => !Object.hasOwn(execution.results, node.id));
}
