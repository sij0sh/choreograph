import type { Checkpoint } from "./checkpoint.ts";
import type { Execution } from "./execution.ts";
import { lastSegment } from "./keys.ts";

/**
 * Commit-maintained lookup indexes over an execution's checkpoints and plans, so
 * binding resolution and prompt rendering read keyed maps instead of rescanning
 * checkpointOrder. The cache is keyed by the checkpoints record identity: start
 * and every snapshot parse (resume, adopt, branch restore) build a fresh record,
 * so the index is rebuilt from the restored order exactly on rollback and adopt.
 */
export type NewestCheckpoint = { readonly key: string; readonly checkpoint: Checkpoint };

export type CheckpointIndex = {
  readonly newestByBlock: Map<string, NewestCheckpoint>;
  readonly planKeyByBlock: Map<string, string>;
};

const cache = new WeakMap<object, CheckpointIndex>();

/** Returns the record-keyed index, building it once per record (newest commit per block wins). */
export function checkpointIndexFor(state: Execution, rootPrefix: string): CheckpointIndex {
  const record = state.checkpoints as object;
  const cached = cache.get(record);
  if (cached) return cached;
  const index = buildIndex(state, rootPrefix);
  cache.set(record, index);
  return index;
}

function buildIndex(state: Execution, rootPrefix: string): CheckpointIndex {
  const newestByBlock = new Map<string, NewestCheckpoint>();
  const order = state.checkpointOrder ?? Object.keys(state.checkpoints);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const key = order[index]!;
    if (!key.startsWith(rootPrefix)) continue;
    const blockId = lastSegment(key);
    if (newestByBlock.has(blockId)) continue;
    const checkpoint = state.checkpoints[key];
    if (checkpoint !== undefined) newestByBlock.set(blockId, { key, checkpoint });
  }
  const planKeyByBlock = new Map<string, string>();
  for (const [key, execution] of Object.entries(state.plans)) {
    planKeyByBlock.set(execution.blockId, key); // the latest plan execution for the block wins
  }
  return { newestByBlock, planKeyByBlock };
}

/** Updates the newest-per-block entry after a commit; no-op until the index is built. */
export function noteCheckpointCommitted(state: Execution, key: string, checkpoint: Checkpoint): void {
  cache.get(state.checkpoints as object)?.newestByBlock.set(lastSegment(key), { key, checkpoint });
}

/** Restores or drops the newest-per-block entry after an in-place checkpoint removal. */
export function noteCheckpointRemoved(state: Execution, key: string, rootPrefix: string): void {
  const index = cache.get(state.checkpoints as object);
  if (!index) return;
  const blockId = lastSegment(key);
  if (index.newestByBlock.get(blockId)?.key !== key) return;
  const restored = restoreNewest(state, rootPrefix, blockId, key);
  if (restored) index.newestByBlock.set(blockId, restored);
  else index.newestByBlock.delete(blockId);
}

function restoreNewest(state: Execution, rootPrefix: string, blockId: string, removedKey: string): NewestCheckpoint | undefined {
  const order = state.checkpointOrder ?? Object.keys(state.checkpoints);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const key = order[index]!;
    if (key === removedKey || !key.startsWith(rootPrefix) || lastSegment(key) !== blockId) continue;
    const checkpoint = state.checkpoints[key];
    if (checkpoint !== undefined) return { key, checkpoint };
  }
  return undefined;
}

/** Points the block at its newly created plan execution; no-op until the index is built. */
export function notePlanKeyCreated(state: Execution, blockId: string, planKey: string): void {
  cache.get(state.checkpoints as object)?.planKeyByBlock.set(blockId, planKey);
}

/** Drops the block's plan entry when its execution is removed; no-op until the index is built. */
export function notePlanKeyRemoved(state: Execution, blockId: string, planKey: string): void {
  const index = cache.get(state.checkpoints as object);
  if (index?.planKeyByBlock.get(blockId) === planKey) index.planKeyByBlock.delete(blockId);
}
