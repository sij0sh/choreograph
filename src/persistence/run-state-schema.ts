import type { Run, Frame, LoopState, PlanRecord } from "../domain/run.ts";
import type { NodeInvocation } from "../domain/node.ts";

type RunStateFieldSchema = {
  readonly entryFields?: readonly string[];
  readonly frameKind?: Frame["kind"];
};

/**
 * The persistence-owned field table for Run.
 * The mapped satisfies clause makes domain fields and persistence entries compile together.
 */
export const RUN_STATE_SCHEMA = {
  workflowName: {},
  runId: {},
  target: {},
  status: {},
  stack: {},
  checkpoints: {},
  checkpointOrder: {},
  plans: {
    entryFields: ["blockId", "plan", "results"] as const satisfies readonly (keyof PlanRecord)[],
  },
  loops: {
    entryFields: ["iteration", "items"] as const satisfies readonly (keyof LoopState)[],
    frameKind: "loop",
  },
  definitionDigest: {},
  invocations: {
    entryFields: ["blockId", "key", "runner", "status", "attempt"] as const satisfies readonly (keyof NodeInvocation)[],
  },
} as const satisfies { [K in keyof Run]-?: RunStateFieldSchema };

export const RUN_STATE_FIELDS = Object.keys(RUN_STATE_SCHEMA) as (keyof Run)[];

export function loopFrameKeys(stack: readonly Frame[]): ReadonlySet<string> {
  const frameKind = RUN_STATE_SCHEMA.loops.frameKind;
  return new Set(stack.filter((frame) => frame.kind === frameKind).map((frame) => frame.key));
}

export function loopStateForFrame(state: Pick<Run, "loops">, frame: Frame): LoopState | undefined {
  return frame.kind === RUN_STATE_SCHEMA.loops.frameKind ? state.loops[frame.key] : undefined;
}
