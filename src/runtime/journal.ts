import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import type { NodeStatus } from "../domain/node.ts";

export const EVENT_ENTRY_TYPE = "choreograph-events";

/**
 * Bounded lifecycle events for a run. These are the events the projection
 * and the TUI consume; they deliberately stay a small closed union so the
 * fold stays total.
 */
export type RunEvent =
  | { readonly type: "run-started"; readonly runId: string; readonly at: number; readonly workflow: string; readonly target: string }
  | { readonly type: "run-resumed"; readonly runId: string; readonly at: number }
  | { readonly type: "node-started"; readonly runId: string; readonly at: number; readonly key: string; readonly runner: "agent" | "process"; readonly attempt: number }
  | { readonly type: "node-succeeded"; readonly runId: string; readonly at: number; readonly key: string }
  | { readonly type: "node-failed"; readonly runId: string; readonly at: number; readonly key: string; readonly reason: string }
  | { readonly type: "node-waiting"; readonly runId: string; readonly at: number; readonly key: string; readonly reason: string }
  | { readonly type: "node-canceled"; readonly runId: string; readonly at: number; readonly key: string }
  | { readonly type: "retry-scheduled"; readonly runId: string; readonly at: number; readonly key: string; readonly attempt: number }
  | { readonly type: "run-paused"; readonly runId: string; readonly at: number; readonly reason: string }
  | { readonly type: "run-completed"; readonly runId: string; readonly at: number }
  | { readonly type: "run-aborted"; readonly runId: string; readonly at: number };

const EVENT_BYTES = 2_048;
const JOURNAL_EVENTS_MAX = 512;

const RUNNER_KINDS = ["agent", "process"] as const;
const EVENT_TYPES = [
  "run-started", "run-resumed", "node-started", "node-succeeded", "node-failed",
  "node-waiting", "node-canceled", "retry-scheduled", "run-paused", "run-completed", "run-aborted",
] as const;

function clip(value: string, max: number): string {
  let clipped = value;
  while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > max) clipped = clipped.slice(0, -16);
  return clipped;
}

function stringAt(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Tolerant parse: unknown event types and malformed entries are dropped so a
 * journal written by a newer engine never blocks a session restore.
 */
export function parseEvent(value: unknown): RunEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0) return undefined;
  if (typeof raw.runId !== "string" || raw.runId.length === 0) return undefined;
  if (!EVENT_TYPES.includes(raw.type as (typeof EVENT_TYPES)[number])) return undefined;
  const base = { runId: raw.runId, at: raw.at };
  switch (raw.type) {
    case "run-started":
      return { ...base, type: "run-started", workflow: stringAt(raw.workflow) ?? "", target: clip(stringAt(raw.target) ?? "", LIMITS.targetBytes) };
    case "run-resumed":
      return { ...base, type: "run-resumed" };
    case "node-started": {
      const key = stringAt(raw.key);
      if (!key || !RUNNER_KINDS.includes(raw.runner as "agent" | "process")) return undefined;
      const attempt = raw.attempt;
      if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return undefined;
      return { ...base, type: "node-started", key, runner: raw.runner as "agent" | "process", attempt };
    }
    case "node-succeeded": {
      const key = stringAt(raw.key);
      return key ? { ...base, type: "node-succeeded", key } : undefined;
    }
    case "node-failed":
    case "node-waiting": {
      const key = stringAt(raw.key);
      if (!key) return undefined;
      return { ...base, type: raw.type as "node-failed" | "node-waiting", key, reason: clip(stringAt(raw.reason) ?? "unknown", 512) };
    }
    case "node-canceled": {
      const key = stringAt(raw.key);
      return key ? { ...base, type: "node-canceled", key } : undefined;
    }
    case "retry-scheduled": {
      const key = stringAt(raw.key);
      const attempt = raw.attempt;
      if (!key || typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return undefined;
      return { ...base, type: "retry-scheduled", key, attempt };
    }
    case "run-paused":
      return { ...base, type: "run-paused", reason: clip(stringAt(raw.reason) ?? "unknown", 512) };
    case "run-completed":
      return { ...base, type: "run-completed" };
    case "run-aborted":
      return { ...base, type: "run-aborted" };
  }
  return undefined;
}

function eventBytes(event: RunEvent): number {
  return canonicalJsonBytes(event as unknown as JsonValue);
}

/**
 * In-memory journal bounded by event count and per-event size. Oversized
 * events are clipped or dropped rather than allowed to grow memory.
 */
export class RunJournal {
  private readonly events: RunEvent[] = [];

  get size(): number {
    return this.events.length;
  }

  get all(): readonly RunEvent[] {
    return this.events;
  }

  append(event: RunEvent): void {
    const bytes = eventBytes(event);
    if (bytes > EVENT_BYTES) return;
    if (this.events.length >= JOURNAL_EVENTS_MAX) this.events.shift();
    this.events.push(event);
  }

  appendParsed(value: unknown): void {
    const event = parseEvent(value);
    if (event) this.append(event);
  }
}

export interface InvocationView {
  readonly key: string;
  readonly runner: "agent" | "process";
  readonly status: NodeStatus;
  readonly attempts: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly lastReason?: string;
}

export interface RunProjection {
  readonly runId: string;
  readonly workflow: string;
  readonly target: string;
  readonly status: "running" | "waiting" | "succeeded" | "failed" | "canceled";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly invocations: Readonly<Record<string, InvocationView>>;
  readonly lastEvent?: RunEvent;
}

const STATUS_BY_EVENT: Partial<Record<RunEvent["type"], NodeStatus>> = {
  "node-started": "running",
  "node-succeeded": "succeeded",
  "node-failed": "failed",
  "node-waiting": "waiting",
  "node-canceled": "canceled",
};

/** Pure fold: rebuild the run view from the journal alone. */
export function project(events: readonly RunEvent[]): RunProjection | undefined {
  let projection: RunProjection | undefined;
  for (const event of events) {
    projection = fold(projection, event);
  }
  return projection;
}

export function fold(previous: RunProjection | undefined, event: RunEvent): RunProjection | undefined {
  switch (event.type) {
    case "run-started":
      return {
        runId: event.runId,
        workflow: event.workflow,
        target: event.target,
        status: "running",
        startedAt: event.at,
        updatedAt: event.at,
        invocations: {},
        lastEvent: event,
      };
    case "run-resumed":
      return previous
        ? { ...previous, status: previous.status === "running" ? "running" : previous.status, updatedAt: event.at, lastEvent: event }
        : undefined;
    case "node-started": {
      if (!previous) return undefined;
      const existing = previous.invocations[event.key];
      const invocation: InvocationView = {
        key: event.key,
        runner: event.runner,
        status: "running",
        attempts: (existing?.attempts ?? 0) + 1,
        startedAt: existing?.startedAt ?? event.at,
        updatedAt: event.at,
        ...(existing?.lastReason ? { lastReason: existing.lastReason } : {}),
      };
      return { ...previous, status: "running", updatedAt: event.at, invocations: { ...previous.invocations, [event.key]: invocation }, lastEvent: event };
    }
    case "node-succeeded":
    case "node-failed":
    case "node-waiting":
    case "node-canceled": {
      if (!previous) return undefined;
      const existing = previous.invocations[event.key];
      if (!existing) return { ...previous, updatedAt: event.at, lastEvent: event };
      const status = STATUS_BY_EVENT[event.type]!;
      const invocation: InvocationView = {
        ...existing,
        status,
        updatedAt: event.at,
        ...("reason" in event ? { lastReason: event.reason } : {}),
      };
      const statusByType: Partial<Record<RunEvent["type"], RunProjection["status"]>> = {
        "node-succeeded": "running",
        "node-waiting": "waiting",
      };
      return { ...previous, ...(statusByType[event.type] ? { status: statusByType[event.type]! } : {}), updatedAt: event.at, invocations: { ...previous.invocations, [event.key]: invocation }, lastEvent: event };
    }
    case "retry-scheduled": {
      if (!previous) return undefined;
      return { ...previous, status: "running", updatedAt: event.at, lastEvent: event };
    }
    case "run-paused":
      return previous ? { ...previous, status: "waiting", updatedAt: event.at, lastEvent: event } : undefined;
    case "run-completed":
      return previous ? { ...previous, status: "succeeded", updatedAt: event.at, lastEvent: event } : undefined;
    case "run-aborted":
      return previous ? { ...previous, status: "canceled", updatedAt: event.at, lastEvent: event } : undefined;
  }
  return previous;
}

export function summarizeProjection(projection: RunProjection): string {
  const invocations = Object.values(projection.invocations);
  const succeeded = invocations.filter((item) => item.status === "succeeded").length;
  const failed = invocations.filter((item) => item.status === "failed").length;
  const waiting = invocations.filter((item) => item.status === "waiting").length;
  const running = invocations.filter((item) => item.status === "running").length;
  return `status=${projection.status} nodes=${invocations.length} running=${running} done=${succeeded} failed=${failed} waiting=${waiting} events-position=${projection.lastEvent?.type ?? "none"}`;
}

export function describeEvent(event: RunEvent): string {
  const time = new Date(event.at).toISOString();
  switch (event.type) {
    case "run-started":
      return `${time} run ${event.runId} started workflow=${event.workflow}${event.target ? ` target=${event.target}` : ""}`;
    case "run-resumed":
      return `${time} run ${event.runId} resumed`;
    case "node-started":
      return `${time} ${event.key} started (runner=${event.runner} attempt=${event.attempt})`;
    case "node-succeeded":
      return `${time} ${event.key} succeeded`;
    case "node-failed":
      return `${time} ${event.key} failed: ${event.reason}`;
    case "node-waiting":
      return `${time} ${event.key} waiting: ${event.reason}`;
    case "node-canceled":
      return `${time} ${event.key} canceled`;
    case "retry-scheduled":
      return `${time} retry scheduled for ${event.key} (attempt=${event.attempt})`;
    case "run-paused":
      return `${time} run ${event.runId} paused: ${event.reason}`;
    case "run-completed":
      return `${time} run ${event.runId} completed`;
    case "run-aborted":
      return `${time} run ${event.runId} aborted`;
  }
}
