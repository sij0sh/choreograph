import { randomUUID } from "node:crypto";
import type { HandoffManifestV1 } from "../domain/handoff.ts";
import { handoffDigest } from "../domain/handoff.ts";

export const TRANSFER_ENTRY_TYPE = "choreograph-transfer";
export const ROLLOVER_COMMAND = "workflow-rollover";

export interface RolloverTransferV1 {
  readonly v: 1;
  readonly kind: "rollover-prepared";
  readonly transferId: string;
  readonly childSessionId: string;
  readonly parentSession?: string;
  readonly runId: string;
  readonly workflow: string;
  readonly terminal: boolean;
  readonly snapshot: unknown;
  readonly manifest: HandoffManifestV1;
  readonly previousEpoch: string;
  readonly seedDigest: string;
}

export interface RolloverCompletedV1 {
  readonly v: 1;
  readonly kind: "rollover-completed";
  readonly transferId: string;
  readonly childSessionId: string;
  readonly childSessionFile: string;
  readonly seedDigest: string;
}

export function createTransfer(fields: Omit<RolloverTransferV1, "v" | "kind" | "transferId" | "childSessionId" | "seedDigest">): RolloverTransferV1 {
  const body = {
    v: 1 as const,
    kind: "rollover-prepared" as const,
    transferId: randomUUID(),
    childSessionId: randomUUID(),
    ...fields,
  };
  return { ...body, seedDigest: handoffDigest(body) };
}

export function preparedTransfer(branch: readonly unknown[], transferId?: string): { transfer: RolloverTransferV1; completed?: RolloverCompletedV1 } | undefined {
  let completed: RolloverCompletedV1 | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== TRANSFER_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as RolloverTransferV1 | RolloverCompletedV1;
    if (transferId && data.transferId !== transferId) continue;
    if (data.kind === "rollover-completed") {
      completed ??= data;
      continue;
    }
    if (data.kind === "rollover-prepared" && data.v === 1) {
      const matching = completed
        && completed.childSessionId === data.childSessionId
        && completed.seedDigest === data.seedDigest
        ? completed
        : undefined;
      return { transfer: data, ...(matching ? { completed: matching } : {}) };
    }
  }
  return undefined;
}

export function validTransferDigest(transfer: RolloverTransferV1): boolean {
  const { seedDigest: _digest, ...body } = transfer;
  return handoffDigest(body) === transfer.seedDigest;
}
