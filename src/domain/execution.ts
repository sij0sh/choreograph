import type { JsonValue } from "./json.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type { DynamicPlan } from "../planning/schema.ts";
import type { NodeInvocation } from "./node.ts";
import { LIMITS } from "./limits.ts";

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

export interface LoopFrame {
  readonly kind: "loop";
  readonly blockId: string;
  readonly key: string;
}

export interface NodeFrame {
  readonly kind: "node";
  readonly blockId: string;
  readonly key: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export type Frame = SequenceFrame | TaskFrame | PlanFrame | NodeFrame | LoopFrame;

export interface PlanExecution {
  readonly blockId: string;
  readonly plan: DynamicPlan;
  readonly results: Readonly<Record<string, import("../domain/checkpoint.ts").Checkpoint>>;
}

type ExecutionStatus = "active" | "completed" | "aborted";

export interface LoopState {
  readonly iteration: number;
  readonly items?: readonly JsonValue[];
}

export interface Execution {
  readonly workflowName: string;
  readonly runId: string;
  readonly target: string;
  readonly status: ExecutionStatus;
  readonly stack: readonly Frame[];
  readonly checkpoints: Readonly<Record<string, Checkpoint>>;
  readonly checkpointOrder: readonly string[];
  readonly plans: Readonly<Record<string, PlanExecution>>;
  readonly loops: Readonly<Record<string, LoopState>>;
  readonly definitionDigest?: string;
  readonly invocations?: Readonly<Record<string, NodeInvocation>>;
}

export function upsertInvocation(
  state: Execution,
  key: string,
  invocation: NodeInvocation,
): Execution["invocations"] {
  const invocations: Record<string, NodeInvocation> = { ...(state.invocations ?? {}), [key]: invocation };
  const keys = Object.keys(invocations);
  if (keys.length <= LIMITS.stackDepth) return invocations;
  for (const candidate of keys) {
    if (keys.length <= LIMITS.stackDepth) break;
    if (invocations[candidate]!.status !== "succeeded") continue;
    delete invocations[candidate];
    keys.splice(keys.indexOf(candidate), 1);
  }
  return invocations;
}
/** A run is parked when its leaf position's invocation is waiting on an operator. */
export function isParked(execution: Execution): boolean {
  const leaf = execution.stack[execution.stack.length - 1];
  return leaf !== undefined && execution.invocations?.[leaf.key]?.status === "waiting";
}
