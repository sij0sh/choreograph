import type { RunEvent } from "./journal.ts";
import { describeEvent, summarizeProjection, type RunProjection } from "./journal.ts";

export type TuiMode = "off" | "compact" | "detailed";

const TUI_MODES: readonly TuiMode[] = ["off", "compact", "detailed"];

export function tuiModeFromEnv(raw: string | undefined, fallback: TuiMode = "compact"): TuiMode {
  return TUI_MODES.includes(raw as TuiMode) ? (raw as TuiMode) : fallback;
}

export function nextTuiMode(current: TuiMode): TuiMode {
  const index = TUI_MODES.indexOf(current);
  return TUI_MODES[(index + 1) % TUI_MODES.length]!;
}

/**
 * Status rendering projects only from the run projection plus the plain
 * position label; it never reads interpreter or stack internals.
 */
export function renderStatus(input: {
  mode: TuiMode;
  compact?: string | undefined;
  projection?: RunProjection | undefined;
}): string | undefined {
  const { mode } = input;
  if (mode === "off") return undefined;
  const compact = input.compact ?? "workflow: idle";
  if (mode === "compact") return input.projection ? `${compact} · ${summarizeProjection(input.projection)}` : compact;
  const projection = input.projection;
  if (!projection) return compact;
  const recent = recentEvents(projection);
  const parts = [
    compact,
    summarizeProjection(projection),
    recent.length ? `recent: ${recent.join(" | ")}` : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

const RECENT_EVENTS_MAX = 3;

export function recentEvents(projection: RunProjection): readonly string[] {
  if (!projection.lastEvent) return [];
  return [describeEvent(projection.lastEvent)];
}

/**
 * Detailed line-oriented log used by workflow_inspect. Most recent events
 * come last so callers can tail the list naturally.
 */
export function renderEventLog(events: readonly RunEvent[], limit: number): readonly string[] {
  const start = Math.max(0, events.length - Math.max(0, limit));
  return events.slice(start).map(describeEvent);
}
