import type { RunEvent } from "./journal.ts";
import { describeEvent, oneLine, summarizeProjection, type InvocationStatus, type RunProjection } from "./journal.ts";

export type TuiMode = "off" | "compact" | "detailed";

const TUI_MODES: readonly TuiMode[] = ["off", "compact", "detailed"];
const DETAIL_ITEMS_MAX = 8;
const DETAIL_LINE_CHARS = 240;

export function tuiModeFromEnv(raw: string | undefined, fallback: TuiMode = "compact"): TuiMode {
  return TUI_MODES.includes(raw as TuiMode) ? (raw as TuiMode) : fallback;
}

export function nextTuiMode(current: TuiMode): TuiMode {
  const index = TUI_MODES.indexOf(current);
  return TUI_MODES[(index + 1) % TUI_MODES.length]!;
}

export function renderStatus(input: {
  mode: TuiMode;
  compact?: string | undefined;
  projection?: RunProjection | undefined;
}): string | undefined {
  const { mode } = input;
  if (mode === "off") return undefined;
  const compact = input.compact ?? "workflow: idle";
  if (mode === "compact") return input.projection ? `${compact} · ${summarizeProjection(input.projection)}` : compact;
  return input.projection ? renderDetailed(input.projection, compact).join("\n") : compact;
}

export function renderDetailed(projection: RunProjection, compact: string = `${projection.workflow}: ${projection.status}`): readonly string[] {
  const lines: string[] = [
    compact,
    `run=${projection.runId} elapsed=${duration(projection.updatedAt - projection.startedAt)}`,
    summarizeProjection(projection),
  ];
  const tree = treeLines(projection);
  if (tree.length > 0) lines.push("tree:", ...tree);
  if (projection.artifacts.length > 0) {
    lines.push("artifacts:");
    for (const artifact of projection.artifacts.slice(-DETAIL_ITEMS_MAX)) {
      lines.push(`  ${artifact.key}/${artifact.output} ${artifact.size}B ${artifact.mediaType} ${shortChecksum(artifact.checksum)}`);
    }
  }
  if (projection.logs.length > 0) {
    lines.push("logs:");
    for (const log of projection.logs.slice(-DETAIL_ITEMS_MAX)) {
      lines.push(`  ${log.key} ${log.stream}: ${oneLine(log.message)}${log.truncated ? " [truncated]" : ""}`);
    }
  }
  const recent = recentEvents(projection);
  if (recent.length > 0) lines.push(`recent: ${recent.join(" | ")}`);
  return lines.map(boundLine);
}

function treeLines(projection: RunProjection): readonly string[] {
  const entries = [
    ...Object.values(projection.loops).map((loop) => ({ kind: "loop" as const, key: loop.key, at: loop.startedAt, loop })),
    ...Object.values(projection.invocations).map((node) => ({ kind: "node" as const, key: node.key, at: node.readyAt ?? node.startedAt ?? node.updatedAt, node })),
  ].sort((left, right) => left.at - right.at || left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind));
  return entries.map((entry) => {
    const indent = "  ".repeat(Math.max(1, entry.key.split("/").length - 1));
    if (entry.kind === "loop") {
      const loop = entry.loop;
      const exhausted = loop.exhausted ? " exhausted" : "";
      return `${indent}${marker(loop.status)} ${loop.key} [loop ${loop.mode}] iteration=${loop.iteration}/${loop.total} state=${loop.status} elapsed=${duration(loop.updatedAt - loop.startedAt)}${exhausted}`;
    }
    const node = entry.node;
    const reason = node.lastReason ? ` reason=${oneLine(node.lastReason)}` : "";
    const elapsedFrom = node.startedAt ?? node.readyAt ?? node.updatedAt;
    return `${indent}${marker(node.status)} ${node.key} [${node.runner}] attempt=${node.attempts} state=${node.status} elapsed=${duration(node.updatedAt - elapsedFrom)}${reason}`;
  });
}

function marker(status: InvocationStatus): string {
  switch (status) {
    case "ready": return "[.]";
    case "running": return "[>]";
    case "waiting": return "[!]";
    case "succeeded": return "[+]";
    case "failed": return "[x]";
    case "skipped": return "[~]";
    case "canceled": return "[-]";
  }
}

function duration(milliseconds: number): string {
  const bounded = Math.max(0, Math.floor(milliseconds));
  if (bounded < 1_000) return `${bounded}ms`;
  const seconds = Math.floor(bounded / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function shortChecksum(checksum: string): string {
  return checksum.length <= 20 ? checksum : `${checksum.slice(0, 20)}...`;
}

function boundLine(value: string): string {
  const indent = value.match(/^ */)?.[0] ?? "";
  const line = `${indent}${oneLine(value)}`;
  return line.length <= DETAIL_LINE_CHARS ? line : `${line.slice(0, DETAIL_LINE_CHARS - 3)}...`;
}

function recentEvents(projection: RunProjection): readonly string[] {
  return projection.lastEvent ? [describeEvent(projection.lastEvent)] : [];
}

export function renderEventLog(events: readonly RunEvent[], limit: number): readonly string[] {
  const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const start = Math.max(0, events.length - bounded);
  return events.slice(start).map(describeEvent);
}
