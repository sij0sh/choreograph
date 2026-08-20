export const SNAPSHOT_TYPE = "pi-workflows";

export type ActiveSnapshot = {
  readonly v: 2;
  readonly status: "active";
  readonly workflow: string;
  readonly runId: string;
  readonly step: number;
  readonly target: string;
  readonly delivered: boolean;
};

export type TerminalSnapshot =
  | { readonly v: 2; readonly status: "completed"; readonly workflow: string; readonly runId: string; readonly totalSteps: number }
  | { readonly v: 2; readonly status: "aborted" };

export type ParsedSnapshot = ActiveSnapshot | { readonly status: "terminal" };

export function isStepIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const snapshot = data as Record<string, unknown>;
  if ((snapshot.v === 1 || snapshot.v === 2) && (snapshot.status === "aborted" || snapshot.status === "completed")) {
    return { status: "terminal" };
  }
  if (snapshot.status !== "active" || (snapshot.v !== 1 && snapshot.v !== 2)) return null;
  if (typeof snapshot.workflow !== "string" || typeof snapshot.runId !== "string") return null;
  if (!isStepIndex(snapshot.step) || typeof snapshot.target !== "string") return null;

  let delivered: boolean;
  if (snapshot.v === 2) {
    if (typeof snapshot.delivered !== "boolean") return null;
    delivered = snapshot.delivered;
  } else {
    if (typeof snapshot.deliveredStep !== "number" || !Number.isInteger(snapshot.deliveredStep)) return null;
    if (snapshot.deliveredStep !== snapshot.step && snapshot.deliveredStep !== snapshot.step - 1) return null;
    delivered = snapshot.deliveredStep === snapshot.step;
  }

  return {
    v: 2,
    status: "active",
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    step: snapshot.step,
    target: snapshot.target,
    delivered,
  };
}

export function latestSnapshot(branch: readonly unknown[]): ParsedSnapshot | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) return parseSnapshot(entry.data);
  }
  return null;
}
