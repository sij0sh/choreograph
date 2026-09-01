import type { Run, Frame, PlanRecord } from "../domain/run.ts";
import { isLeafFrame } from "../domain/run.ts";
import { planKeyOf } from "../domain/keys.ts";
import { blockOf, type PlanBlock, type TaskBlock, type Workflow } from "../domain/workflow.ts";
import type { PlanNode } from "../planning/schema.ts";
import { firstIncompleteNode } from "../planning/graph.ts";

interface PositionInfo {
  readonly type: "task" | "plan-create" | "node";
  readonly key: string;
  readonly attempt: number;
  readonly task?: TaskBlock;
  readonly plan?: PlanBlock;
  readonly node?: PlanNode;
  readonly execution?: PlanRecord;
  readonly stack: readonly Frame[];
}

export function currentPosition(workflow: Workflow, state: Run): PositionInfo | undefined {
  if (state.status !== "active") return undefined;
  const leaf = state.stack[state.stack.length - 1];
  if (!leaf || !isLeafFrame(leaf)) return undefined;
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    if (block?.kind === "task") {
      return { type: "task", key: leaf.key, attempt: leaf.attempt, task: block, stack: state.stack };
    }
    return undefined;
  }
  if (leaf.kind === "plan") {
    const block = blockOf(workflow, leaf.blockId);
    if (block?.kind === "plan") {
      return { type: "plan-create", key: leaf.key, attempt: leaf.attempt, plan: block, execution: state.plans[leaf.key], stack: state.stack };
    }
    return undefined;
  }
  if (leaf.kind === "node") {
    const block = blockOf(workflow, leaf.blockId);
    const planKey = planKeyOf(leaf.key);
    const record = state.plans[planKey];
    const node = record?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
    if (block?.kind === "plan" && record && node) {
      return { type: "node", key: leaf.key, attempt: leaf.attempt, plan: block, node, execution: record, stack: state.stack };
    }
    return undefined;
  }
  return undefined;
}

export type { PositionInfo };
