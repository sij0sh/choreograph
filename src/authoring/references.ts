import type { Execution } from "../domain/execution.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import type { JsonValue } from "../domain/json.ts";
import type { DataReference } from "../domain/workflow.ts";
import { LIMITS } from "../domain/limits.ts";

const REFERENCE_PATTERN = /^\$([a-z][a-z0-9-]*)((?:\.[A-Za-z0-9_-]+)*)$/;

export function parseReference(raw: string, label = "reference"): DataReference {
  if (typeof raw !== "string" || !REFERENCE_PATTERN.test(raw)) {
    throw new Error(`${label} must look like $task-id or $task-id.field with dotted segments`);
  }
  const match = raw.match(REFERENCE_PATTERN)!;
  const root = match[1];
  const path = match[2] ? match[2].slice(1).split(".") : [];
  if (path.length > LIMITS.referenceDepth) {
    throw new Error(`${label} must not exceed ${LIMITS.referenceDepth} path segments`);
  }
  return { root, path };
}

function descend(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as { [key: string]: JsonValue | undefined })[segment];
  }
  return current;
}

function lastSegment(key: string): string {
  const index = key.lastIndexOf("/");
  return index < 0 ? key : key.slice(index + 1);
}

function currentIteration(state: Execution): JsonValue | undefined {
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    const frame = state.stack[i];
    if (frame.kind === "foreach") return frame.items[frame.index];
  }
  return undefined;
}

export function resolveReference(state: Execution, reference: DataReference): JsonValue | undefined {
  if (reference.root === "current") {
    const item = currentIteration(state);
    if (item === undefined) return undefined;
    return descend(item, reference.path);
  }
  let latest: Checkpoint | undefined;
  for (const [key, checkpoint] of Object.entries(state.checkpoints)) {
    if (lastSegment(key) === reference.root) latest = checkpoint;
  }
  if (latest) return descend(latest.data, reference.path);
  for (const plan of Object.values(state.plans)) {
    const result = plan.results[reference.root];
    if (result) return descend(result.data, reference.path);
  }
  return undefined;
}
