import type { PlanExecution } from "../domain/execution.ts";
import type { DynamicPlan, PlanNode } from "./schema.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";

export function firstIncompleteNode(execution: PlanExecution): PlanNode | undefined {
  return execution.plan.nodes.find((node) => execution.results[node.id] === undefined);
}

export function invalidateResults(execution: PlanExecution, requested: readonly string[]): { execution: PlanExecution; removed: string[] } {
  const results = { ...execution.results };
  const removed = new Set<string>();
  for (const id of requested) {
    if (results[id] !== undefined) {
      delete results[id];
      removed.add(id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of execution.plan.nodes) {
      if (removed.has(node.id) || results[node.id] === undefined) continue;
      const dependsOnInvalidated = (node.dependsOn ?? []).some((dependency) => removed.has(dependency));
      if (dependsOnInvalidated) {
        delete results[node.id];
        removed.add(node.id);
        changed = true;
      }
    }
  }
  const ordered = execution.plan.nodes.filter((node) => removed.has(node.id)).map((node) => node.id);
  return { execution: { ...execution, results }, removed: ordered };
}

