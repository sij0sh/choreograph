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

export interface NodeResult {
  readonly id: string;
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly decisions?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly data?: import("../domain/json.ts").JsonValue;
}
