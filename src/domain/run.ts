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

export type PlanFrame = {
  readonly kind: "plan";
  readonly blockId: string;
  readonly key: string;
  readonly mode: "create" | "execute";
  readonly attempt: number;
};

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

export type AttemptBearingFrame = TaskFrame | PlanFrame | NodeFrame;
export type LeafFrame = TaskFrame | NodeFrame | (PlanFrame & { readonly mode: "create" });
export type StructuralFrame = SequenceFrame | LoopFrame | (PlanFrame & { readonly mode: "execute" });
export type AgentDispatchFrame = AttemptBearingFrame;

type FrameRoles = {
  readonly leaf: boolean;
  readonly attemptBearing: boolean;
  readonly structural: boolean;
};

function frameRoles(frame: Frame): FrameRoles {
  switch (frame.kind) {
    case "task":
    case "node":
      return { leaf: true, attemptBearing: true, structural: false };
    case "plan":
      switch (frame.mode) {
        case "create":
          return { leaf: true, attemptBearing: true, structural: false };
        case "execute":
          return { leaf: false, attemptBearing: true, structural: true };
        default: {
          const exhaustive: never = frame.mode;
          return exhaustive;
        }
      }
    case "sequence":
    case "loop":
      return { leaf: false, attemptBearing: false, structural: true };
    default: {
      const exhaustive: never = frame;
      return exhaustive;
    }
  }
}

export function isAttemptBearingFrame(frame: Frame): frame is AttemptBearingFrame {
  return frameRoles(frame).attemptBearing;
}

export function isLeafFrame(frame: Frame): frame is LeafFrame {
  return frameRoles(frame).leaf;
}

export function isStructuralFrame(frame: Frame): frame is StructuralFrame {
  return frameRoles(frame).structural;
}

/** The runtime dispatch projection intentionally includes plan execution frames, unlike isLeafFrame. */
export function isAgentDispatchFrame(frame: Frame): frame is AgentDispatchFrame {
  return isAttemptBearingFrame(frame);
}

export function frameAttempt(frame: Frame): number {
  return isAttemptBearingFrame(frame) ? frame.attempt : 1;
}

export interface PlanRecord {
  readonly blockId: string;
  readonly plan: DynamicPlan;
  readonly results: Readonly<Record<string, import("../domain/checkpoint.ts").Checkpoint>>;
}

type RunStatus = "active" | "completed" | "aborted";

export interface LoopState {
  readonly iteration: number;
  readonly items?: readonly JsonValue[];
}

export interface Run {
  readonly workflowName: string;
  readonly runId: string;
  readonly target: string;
  readonly status: RunStatus;
  readonly stack: readonly Frame[];
  readonly checkpoints: Readonly<Record<string, Checkpoint>>;
  readonly checkpointOrder: readonly string[];
  readonly plans: Readonly<Record<string, PlanRecord>>;
  readonly loops: Readonly<Record<string, LoopState>>;
  readonly definitionDigest?: string;
  readonly invocations?: Readonly<Record<string, NodeInvocation>>;
}

export function upsertInvocation(
  state: Run,
  key: string,
  invocation: NodeInvocation,
): Run["invocations"] {
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
export function isParked(run: Run): boolean {
  const leaf = run.stack[run.stack.length - 1];
  return leaf !== undefined && run.invocations?.[leaf.key]?.status === "waiting";
}
