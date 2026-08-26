import { ID_PATTERN, LIMITS } from "../domain/limits.ts";

export interface PlanNode {
  readonly id: string;
  readonly operator: string;
  readonly objective: string;
  readonly dependsOn?: readonly string[];
  readonly evidence?: readonly string[];
  readonly done: readonly string[];
}

export interface DynamicPlan {
  readonly version: 1;
  readonly nodes: readonly PlanNode[];
}

