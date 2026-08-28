import type { ArtifactRef } from "../domain/artifacts.ts";
import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import type { NodeStatus, RunnerKind } from "../domain/node.ts";
import type { LoopBlock } from "../domain/workflow.ts";

export const EVENT_ENTRY_TYPE = "choreograph-events";

const RUNNER_KINDS = ["agent", "process"] as const;
const EVENT_RUNNER_KINDS = [...RUNNER_KINDS, "control"] as const;
const LOOP_MODES = ["for-each", "repeat-until"] as const;
const LOG_STREAMS = ["stdout", "stderr", "progress"] as const;

export type EventRunner = (typeof EVENT_RUNNER_KINDS)[number];
export type InvocationStatus = NodeStatus | "ready";
type LoopMode = LoopBlock["mode"];
type LogStream = (typeof LOG_STREAMS)[number];

interface RunEventBase {
  readonly runId: string;
  readonly at: number;
}

export type RunEvent = RunEventBase & (
  | { readonly type: "run-started"; readonly workflow: string; readonly target: string }
  | { readonly type: "run-resumed" }
  | { readonly type: "node-ready"; readonly key: string; readonly runner: RunnerKind; readonly attempt: number }
  | { readonly type: "node-started"; readonly key: string; readonly runner: RunnerKind; readonly attempt: number }
  | { readonly type: "node-succeeded"; readonly key: string }
  | { readonly type: "node-failed"; readonly key: string; readonly reason: string }
  | { readonly type: "node-waiting"; readonly key: string; readonly reason: string }
  | { readonly type: "node-skipped"; readonly key: string; readonly runner: EventRunner; readonly reason: string }
  | { readonly type: "node-canceled"; readonly key: string }
  | { readonly type: "retry-scheduled"; readonly key: string; readonly attempt: number }
  | { readonly type: "loop-iteration-started"; readonly key: string; readonly mode: LoopMode; readonly iteration: number; readonly total: number }
  | { readonly type: "loop-completed"; readonly key: string; readonly mode: LoopMode; readonly iterations: number; readonly total: number; readonly exhausted: boolean }
  | ({ readonly type: "artifact-published"; readonly key: string } & Pick<ArtifactRef, "output" | "checksum" | "size" | "mediaType">)
  | { readonly type: "node-log"; readonly key: string; readonly stream: LogStream; readonly message: string; readonly truncated: boolean }
  | { readonly type: "run-paused"; readonly reason: string }
  | { readonly type: "run-completed" }
  | { readonly type: "run-aborted" }
);

const EVENT_BYTES = 2_048;
const EVENT_TEXT_BYTES = 512;
const JOURNAL_EVENTS_MAX = 512;
const PROJECTION_LOGS_MAX = 16;
const PROJECTION_ARTIFACTS_MAX = 32;

function clip(value: string, max: number): string {
  let clipped = value;
  while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > max) clipped = clipped.slice(0, -16);
  return clipped;
}

function clipped(value: string, max: number): { value: string; truncated: boolean } {
  const result = clip(value, max);
  return { value: result, truncated: result !== value };
}

function stringAt(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerAt(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum ? value : undefined;
}

export function parseEvent(value: unknown): RunEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0) return undefined;
  if (typeof raw.runId !== "string" || raw.runId.length === 0) return undefined;
  const base = { runId: raw.runId, at: raw.at };
  switch (raw.type) {
    case "run-started":
      return { ...base, type: "run-started", workflow: stringAt(raw.workflow) ?? "", target: clip(stringAt(raw.target) ?? "", LIMITS.targetBytes) };
    case "run-resumed":
      return { ...base, type: "run-resumed" };
    case "node-ready":
    case "node-started": {
      const key = stringAt(raw.key);
      const attempt = integerAt(raw.attempt, 1);
      if (!key || attempt === undefined || !RUNNER_KINDS.includes(raw.runner as RunnerKind)) return undefined;
      return { ...base, type: raw.type, key, runner: raw.runner as RunnerKind, attempt };
    }
    case "node-succeeded": {
      const key = stringAt(raw.key);
      return key ? { ...base, type: "node-succeeded", key } : undefined;
    }
    case "node-failed":
    case "node-waiting": {
      const key = stringAt(raw.key);
      if (!key) return undefined;
      return { ...base, type: raw.type, key, reason: clip(stringAt(raw.reason) ?? "unknown", EVENT_TEXT_BYTES) };
    }
    case "node-skipped": {
      const key = stringAt(raw.key);
      if (!key || !EVENT_RUNNER_KINDS.includes(raw.runner as EventRunner)) return undefined;
      return { ...base, type: "node-skipped", key, runner: raw.runner as EventRunner, reason: clip(stringAt(raw.reason) ?? "guard did not hold", EVENT_TEXT_BYTES) };
    }
    case "node-canceled": {
      const key = stringAt(raw.key);
      return key ? { ...base, type: "node-canceled", key } : undefined;
    }
    case "retry-scheduled": {
      const key = stringAt(raw.key);
      const attempt = integerAt(raw.attempt, 1);
      if (!key || attempt === undefined) return undefined;
      return { ...base, type: "retry-scheduled", key, attempt };
    }
    case "loop-iteration-started": {
      const key = stringAt(raw.key);
      const iteration = integerAt(raw.iteration, 1);
      const total = integerAt(raw.total, 1);
      if (!key || iteration === undefined || total === undefined || iteration > total || !LOOP_MODES.includes(raw.mode as LoopMode)) return undefined;
      return { ...base, type: "loop-iteration-started", key, mode: raw.mode as LoopMode, iteration, total };
    }
    case "loop-completed": {
      const key = stringAt(raw.key);
      const iterations = integerAt(raw.iterations, 0);
      const total = integerAt(raw.total, 0);
      if (!key || iterations === undefined || total === undefined || iterations > total || typeof raw.exhausted !== "boolean" || !LOOP_MODES.includes(raw.mode as LoopMode)) return undefined;
      return { ...base, type: "loop-completed", key, mode: raw.mode as LoopMode, iterations, total, exhausted: raw.exhausted };
    }
    case "artifact-published": {
      const key = stringAt(raw.key);
      const output = stringAt(raw.output);
      const checksum = stringAt(raw.checksum);
      const size = integerAt(raw.size, 0);
      const mediaType = stringAt(raw.mediaType);
      if (!key || !output || !checksum || size === undefined || !mediaType) return undefined;
      return { ...base, type: "artifact-published", key, output, checksum, size, mediaType };
    }
    case "node-log": {
      const key = stringAt(raw.key);
      const message = stringAt(raw.message);
      if (!key || !message || !LOG_STREAMS.includes(raw.stream as LogStream)) return undefined;
      const normalized = clipped(message, EVENT_TEXT_BYTES);
      return {
        ...base,
        type: "node-log",
        key,
        stream: raw.stream as LogStream,
        message: normalized.value,
        truncated: raw.truncated === true || normalized.truncated,
      };
    }
    case "run-paused":
      return { ...base, type: "run-paused", reason: clip(stringAt(raw.reason) ?? "unknown", EVENT_TEXT_BYTES) };
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

export class RunJournal {
  private readonly events: RunEvent[] = [];

  get size(): number {
    return this.events.length;
  }

  get all(): readonly RunEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
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
  readonly runner: EventRunner;
  readonly status: InvocationStatus;
  readonly attempts: number;
  readonly readyAt?: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly lastReason?: string;
}

export interface LoopView {
  readonly key: string;
  readonly mode: LoopMode;
  readonly status: "running" | "succeeded" | "canceled";
  readonly iteration: number;
  readonly total: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly exhausted?: boolean;
}

export type ArtifactView = Extract<RunEvent, { type: "artifact-published" }>;
export type LogView = Extract<RunEvent, { type: "node-log" }>;

export interface RunProjection {
  readonly runId: string;
  readonly workflow: string;
  readonly target: string;
  readonly status: "running" | "waiting" | "succeeded" | "failed" | "canceled";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly invocations: Readonly<Record<string, InvocationView>>;
  readonly loops: Readonly<Record<string, LoopView>>;
  readonly artifacts: readonly ArtifactView[];
  readonly logs: readonly LogView[];
  readonly lastEvent?: RunEvent;
}

const STATUS_BY_EVENT: Partial<Record<RunEvent["type"], InvocationStatus>> = {
  "node-succeeded": "succeeded",
  "node-failed": "failed",
  "node-waiting": "waiting",
  "node-canceled": "canceled",
};

function tail<T>(values: readonly T[], max: number): readonly T[] {
  return values.length <= max ? values : values.slice(values.length - max);
}

function withEvent(previous: RunProjection, event: RunEvent, changes: Partial<RunProjection> = {}): RunProjection {
  return {
    ...previous,
    ...changes,
    updatedAt: event.at,
    lastEvent: event,
  };
}

function terminalInvocation(previous: RunProjection, event: Extract<RunEvent, { type: "node-succeeded" | "node-failed" | "node-waiting" | "node-canceled" }>): InvocationView {
  const existing = previous.invocations[event.key];
  return {
    key: event.key,
    runner: existing?.runner ?? "agent",
    status: STATUS_BY_EVENT[event.type]!,
    attempts: existing?.attempts ?? 1,
    ...(existing?.readyAt !== undefined ? { readyAt: existing.readyAt } : {}),
    ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
    updatedAt: event.at,
    ...(existing?.lastReason ? { lastReason: existing.lastReason } : {}),
    ...("reason" in event ? { lastReason: event.reason } : {}),
  };
}

function readyInvocation(previous: RunProjection, key: string, at: number, attempt: number, runner?: EventRunner): InvocationView {
  const existing = previous.invocations[key];
  return {
    key,
    runner: runner ?? existing?.runner ?? "agent",
    status: "ready",
    attempts: Math.max(existing?.attempts ?? 0, attempt),
    readyAt: at,
    ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
    updatedAt: at,
    ...(existing?.lastReason ? { lastReason: existing.lastReason } : {}),
  };
}

export function project(events: readonly RunEvent[]): RunProjection | undefined {
  let projection: RunProjection | undefined;
  for (const event of events) projection = fold(projection, event);
  return projection;
}

export function fold(previous: RunProjection | undefined, event: RunEvent): RunProjection | undefined {
  if (event.type === "run-started") {
    return {
      runId: event.runId,
      workflow: event.workflow,
      target: event.target,
      status: "running",
      startedAt: event.at,
      updatedAt: event.at,
      invocations: {},
      loops: {},
      artifacts: [],
      logs: [],
      lastEvent: event,
    };
  }
  if (!previous || previous.runId !== event.runId) return previous;
  switch (event.type) {
    case "run-resumed":
      return withEvent(previous, event, { status: "running" });
    case "node-ready": {
      const invocation = readyInvocation(previous, event.key, event.at, event.attempt, event.runner);
      return withEvent(previous, event, { status: "running", invocations: { ...previous.invocations, [event.key]: invocation } });
    }
    case "node-started": {
      const existing = previous.invocations[event.key];
      const invocation: InvocationView = {
        key: event.key,
        runner: event.runner,
        status: "running",
        attempts: Math.max(existing?.attempts ?? 0, event.attempt),
        ...(existing?.readyAt !== undefined ? { readyAt: existing.readyAt } : {}),
        startedAt: event.at,
        updatedAt: event.at,
        ...(existing?.lastReason ? { lastReason: existing.lastReason } : {}),
      };
      return withEvent(previous, event, { status: "running", invocations: { ...previous.invocations, [event.key]: invocation } });
    }
    case "node-succeeded":
    case "node-failed":
    case "node-waiting":
    case "node-canceled": {
      const invocation = terminalInvocation(previous, event);
      const statusByType: Record<typeof event.type, RunProjection["status"]> = {
        "node-succeeded": "running",
        "node-failed": "failed",
        "node-waiting": "waiting",
        "node-canceled": "canceled",
      };
      return withEvent(previous, event, { status: statusByType[event.type], invocations: { ...previous.invocations, [event.key]: invocation } });
    }
    case "node-skipped": {
      const existing = previous.invocations[event.key];
      const invocation: InvocationView = {
        key: event.key,
        runner: event.runner,
        status: "skipped",
        attempts: existing?.attempts ?? 0,
        ...(existing?.readyAt !== undefined ? { readyAt: existing.readyAt } : {}),
        ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
        updatedAt: event.at,
        lastReason: event.reason,
      };
      return withEvent(previous, event, { invocations: { ...previous.invocations, [event.key]: invocation } });
    }
    case "retry-scheduled": {
      const invocation = readyInvocation(previous, event.key, event.at, event.attempt);
      return withEvent(previous, event, { status: "running", invocations: { ...previous.invocations, [event.key]: invocation } });
    }
    case "loop-iteration-started": {
      const existing = previous.loops[event.key];
      const loop: LoopView = {
        key: event.key,
        mode: event.mode,
        status: "running",
        iteration: event.iteration,
        total: event.total,
        startedAt: existing?.startedAt ?? event.at,
        updatedAt: event.at,
      };
      return withEvent(previous, event, { status: "running", loops: { ...previous.loops, [event.key]: loop } });
    }
    case "loop-completed": {
      const existing = previous.loops[event.key];
      const loop: LoopView = {
        key: event.key,
        mode: event.mode,
        status: "succeeded",
        iteration: event.iterations,
        total: event.total,
        startedAt: existing?.startedAt ?? event.at,
        updatedAt: event.at,
        ...(event.exhausted ? { exhausted: true } : {}),
      };
      return withEvent(previous, event, { loops: { ...previous.loops, [event.key]: loop } });
    }
    case "artifact-published":
      return withEvent(previous, event, { artifacts: tail([...previous.artifacts, event], PROJECTION_ARTIFACTS_MAX) });
    case "node-log":
      return withEvent(previous, event, { logs: tail([...previous.logs, event], PROJECTION_LOGS_MAX) });
    case "run-paused":
      return withEvent(previous, event, { status: "waiting" });
    case "run-completed": {
      const loops = Object.fromEntries(Object.entries(previous.loops).map(([key, loop]) => [key, loop.status === "running" ? { ...loop, status: "succeeded" as const, updatedAt: event.at } : loop]));
      return withEvent(previous, event, { status: "succeeded", loops });
    }
    case "run-aborted": {
      const invocations = Object.fromEntries(Object.entries(previous.invocations).map(([key, invocation]) => [
        key,
        invocation.status === "running" || invocation.status === "ready"
          ? { ...invocation, status: "canceled" as const, updatedAt: event.at }
          : invocation,
      ]));
      const loops = Object.fromEntries(Object.entries(previous.loops).map(([key, loop]) => [key, loop.status === "running" ? { ...loop, status: "canceled" as const, updatedAt: event.at } : loop]));
      return withEvent(previous, event, { status: "canceled", invocations, loops });
    }
  }
}

export function summarizeProjection(projection: RunProjection): string {
  const invocations = Object.values(projection.invocations);
  const count = (status: InvocationStatus): number => invocations.filter((item) => item.status === status).length;
  const activeLoop = Object.values(projection.loops).filter((loop) => loop.status === "running").at(-1);
  const loopPosition = activeLoop ? ` iteration=${activeLoop.iteration}/${activeLoop.total}` : "";
  return `status=${projection.status} nodes=${invocations.length} ready=${count("ready")} running=${count("running")} done=${count("succeeded")} skipped=${count("skipped")} failed=${count("failed")} waiting=${count("waiting")} canceled=${count("canceled")} loops=${Object.keys(projection.loops).length}${loopPosition} artifacts=${projection.artifacts.length} events-position=${projection.lastEvent?.type ?? "none"}`;
}

export function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function describeEvent(event: RunEvent): string {
  const time = new Date(event.at).toISOString();
  switch (event.type) {
    case "run-started":
      return `${time} run ${event.runId} started workflow=${event.workflow}${event.target ? ` target=${oneLine(event.target)}` : ""}`;
    case "run-resumed":
      return `${time} run ${event.runId} resumed`;
    case "node-ready":
      return `${time} ${event.key} ready (runner=${event.runner} attempt=${event.attempt})`;
    case "node-started":
      return `${time} ${event.key} started (runner=${event.runner} attempt=${event.attempt})`;
    case "node-succeeded":
      return `${time} ${event.key} succeeded`;
    case "node-failed":
      return `${time} ${event.key} failed: ${oneLine(event.reason)}`;
    case "node-waiting":
      return `${time} ${event.key} waiting: ${oneLine(event.reason)}`;
    case "node-skipped":
      return `${time} ${event.key} skipped: ${oneLine(event.reason)}`;
    case "node-canceled":
      return `${time} ${event.key} canceled`;
    case "retry-scheduled":
      return `${time} retry scheduled for ${event.key} (attempt=${event.attempt})`;
    case "loop-iteration-started":
      return `${time} ${event.key} iteration ${event.iteration}/${event.total} started (${event.mode})`;
    case "loop-completed":
      return `${time} ${event.key} completed ${event.iterations}/${event.total} iteration${event.total === 1 ? "" : "s"} (${event.mode})${event.exhausted ? " (exhausted)" : ""}`;
    case "artifact-published":
      return `${time} ${event.key} published ${event.output} (${event.size} bytes, ${event.mediaType}, ${event.checksum})`;
    case "node-log":
      return `${time} ${event.key} ${event.stream}: ${oneLine(event.message)}${event.truncated ? " [truncated]" : ""}`;
    case "run-paused":
      return `${time} run ${event.runId} paused: ${oneLine(event.reason)}`;
    case "run-completed":
      return `${time} run ${event.runId} completed`;
    case "run-aborted":
      return `${time} run ${event.runId} aborted`;
  }
}
