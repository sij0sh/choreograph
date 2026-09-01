import type { PlanRecord } from "../domain/run.ts";
import type { PlanNode } from "./schema.ts";
import { completedPlanNodeOf } from "../domain/artifacts.ts";

export function firstIncompleteNode(record: PlanRecord): PlanNode | undefined {
  return record.plan.nodes.find((node) => completedPlanNodeOf(record, node.id) === undefined);
}
