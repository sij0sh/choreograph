import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../domain/json.ts";

export const TRANSFER_ENTRY_TYPE = "choreograph-transfer";
export const ROLLOVER_COMMAND = "workflow-rollover";

export interface RolloverTransferV2 {
  readonly v: 2;
  readonly kind: "rollover-prepared";
  readonly transferId: string;
  readonly childSessionId: string;
  readonly parentSession?: string;
  readonly runId: string;
  readonly workflow: string;
  readonly terminal: boolean;
  readonly snapshot: unknown;
  readonly digest: string;
}

export interface RolloverCompletedV2 {
  readonly v: 2;
  readonly kind: "rollover-completed";
  readonly transferId: string;
  readonly childSessionId: string;
  readonly childSessionFile: string;
  readonly digest: string;
}

function transferDigest(value: unknown): string {
  return `sha256-${createHash("sha256").update(canonicalJson(value as never)).digest("hex")}`;
}

export function createTransfer(fields: Omit<RolloverTransferV2, "v" | "kind" | "transferId" | "childSessionId" | "digest">): RolloverTransferV2 {
  const body = {
    v: 2 as const,
    kind: "rollover-prepared" as const,
    transferId: randomUUID(),
    childSessionId: randomUUID(),
    ...fields,
  };
  return { ...body, digest: transferDigest(body) };
}

export function preparedTransfer(branch: readonly unknown[], transferId?: string): { transfer: RolloverTransferV2; completed?: RolloverCompletedV2 } | undefined {
  let completed: RolloverCompletedV2 | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== TRANSFER_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as RolloverTransferV2 | RolloverCompletedV2;
    if (transferId && data.transferId !== transferId) continue;
    if (data.kind === "rollover-completed") {
      completed ??= data;
      continue;
    }
    if (data.kind === "rollover-prepared" && data.v === 2) {
      const matching = completed
        && completed.childSessionId === data.childSessionId
        && completed.digest === data.digest
        ? completed
        : undefined;
      return { transfer: data, ...(matching ? { completed: matching } : {}) };
    }
  }
  return undefined;
}

export function validTransferDigest(transfer: RolloverTransferV2): boolean {
  const { digest: _digest, ...body } = transfer;
  return transferDigest(body) === transfer.digest;
}
