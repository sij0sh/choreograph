import type { JsonValue } from "./json.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type { DynamicPlan, NodeResult } from "../planning/schema.ts";

export interface SequenceFrame {
  readonly kind: "sequence";
  readonly blockId: string;
  readonly key: string;
  readonly index: number;
}

export interface TaskFrame {
  readonly kind: "task";
  readonly blockId: string;
  readonly key: string;
  readonly attempt: number;
}

type PlanFrame = {
  readonly kind: "plan";
  readonly blockId: string;
  readonly key: string;
  readonly mode: "create" | "execute";
  readonly attempt: number;
}

export interface NodeFrame {
  readonly kind: "node";
  readonly blockId: string;
  readonly key: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export type Frame = SequenceFrame | TaskFrame | PlanFrame | NodeFrame;

export interface PlanExecution {
  readonly blockId: string;
  readonly revision: number;
  readonly replans: number;
  readonly invalidations: number;
  readonly awaitingPlan?: boolean;
  readonly plan: DynamicPlan;
  readonly results: Readonly<Record<string, NodeResult>>;
}

type ExecutionStatus = "active" | "completed" | "aborted";

export interface Execution {
  readonly workflowName: string;
  readonly runId: string;
  readonly target: string;
  readonly status: ExecutionStatus;
  readonly stack: readonly Frame[];
  readonly checkpoints: Readonly<Record<string, Checkpoint>>;
  readonly plans: Readonly<Record<string, PlanExecution>>;
}
