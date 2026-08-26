import type { PlanExecution } from "../domain/execution.ts";
import type { DynamicPlan, PlanNode } from "./schema.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";

export function firstIncompleteNode(execution: PlanExecution): PlanNode | undefined {
  return execution.plan.nodes.find((node) => !Object.hasOwn(execution.results, node.id));
}

export function invalidateResults(execution: PlanExecution, requested: readonly string[]): { execution: PlanExecution; removed: string[] } {
  const results = { ...execution.results };
  const removed = new Set<string>();
  for (const id of requested) {
    if (Object.hasOwn(results, id)) {
      delete results[id];
      removed.add(id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of execution.plan.nodes) {
      if (removed.has(node.id) || !Object.hasOwn(results, node.id)) continue;
      const dependsOnInvalidated = (node.dependsOn ?? []).some((dependency) => removed.has(dependency));
      if (dependsOnInvalidated) {
        delete results[node.id];
        removed.add(node.id);
        changed = true;
      }
    }
  }
  const currentIds = new Set(execution.plan.nodes.map((node) => node.id));
  const ordered = [
    ...execution.plan.nodes.filter((node) => removed.has(node.id)).map((node) => node.id),
    ...[...removed].filter((id) => !currentIds.has(id)).sort(),
  ];
  const resultOperators = { ...(execution.resultOperators ?? {}) };
  for (const id of removed) delete resultOperators[id];
  return {
    execution: {
      ...execution,
      results,
      ...(Object.keys(resultOperators).length > 0 ? { resultOperators } : {}),
    },
    removed: ordered,
  };
}

