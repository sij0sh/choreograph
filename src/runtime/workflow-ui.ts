import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAttemptBearingFrame, type Execution, type Frame } from "../domain/execution.ts";
import { blockOf, type Block, type Workflow } from "../domain/workflow.ts";

/** Persistent view selector; `inspect` exists only for the on-demand panel. */
export type WorkflowUiMode = "off" | "compact" | "detailed";
export type WorkflowVerbosity = Exclude<WorkflowUiMode, "off"> | "inspect";

const UI_MODES: readonly WorkflowUiMode[] = ["off", "compact", "detailed"];
export const DEFAULT_WORKFLOW_UI_MODE: WorkflowUiMode = "compact";

export function parseWorkflowUiMode(value: string | undefined | null): WorkflowUiMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return UI_MODES.find((mode) => mode === normalized);
}

/** Absent or invalid CHOREOGRAPH_TUI values select the default rail. */
export function workflowUiModeFromEnv(value: string | undefined): WorkflowUiMode {
  return parseWorkflowUiMode(value) ?? DEFAULT_WORKFLOW_UI_MODE;
}

export function nextWorkflowUiMode(mode: WorkflowUiMode): WorkflowUiMode {
  return mode === "off" ? "compact" : mode === "compact" ? "detailed" : "off";
}

export type PhaseState = "complete" | "active" | "skipped" | "pending";

export type PhaseView = {
  readonly label: string;
  readonly state: PhaseState;
  readonly progress?: string;
};

export type CompletedView = {
  readonly label: string;
  readonly summary: string;
};

export type WorkflowView = {
  readonly workflow: string;
  readonly runId: string;
  readonly state: "running" | "waiting";
  readonly phases: readonly PhaseView[];
  readonly current?: {
    readonly path: string;
    readonly runner: "agent" | "process";
    readonly attempt: number;
    readonly loop?: { readonly iteration: number; readonly total: number };
    readonly plan?: { readonly completed: number; readonly total: number };
  };
  readonly attention?: string;
  readonly completed: readonly CompletedView[];
};

const VIEW_LIMITS = {
  summaryBytes: 96,
  attentionBytes: 96,
  completedItems: 12,
} as const;

function clipText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes - 3) break;
    bytes += size;
    end += char.length;
  }
  return `${value.slice(0, end).trimEnd()}...`;
}

function stripKeyPrefix(rootId: string, key: string): string {
  return key === rootId || !key.startsWith(`${rootId}/`) ? key : key.slice(rootId.length + 1);
}

function runnerOfLeaf(workflow: Workflow, leaf: Frame | undefined): "agent" | "process" {
  if (leaf?.kind === "task") return blockOf(workflow, leaf.blockId)?.kind === "script" ? "process" : "agent";
  return "agent";
}

/**
 * Derives the whole presentation model from the authoritative runtime inputs.
 * The interpreter increments a sequence cursor before pushing its child, so the
 * active top-level child sits one behind the root cursor.
 */
export function buildWorkflowView(workflow: Workflow, execution: Execution): WorkflowView | undefined {
  if (execution.status !== "active") return undefined;
  const rootFrame = execution.stack[0];
  if (!rootFrame || rootFrame.kind !== "sequence" || rootFrame.blockId !== workflow.root.id) return undefined;
  const rootId = workflow.root.id;
  const children = workflow.root.children;
  const activeIndex = Math.min(Math.max(rootFrame.index - 1, 0), children.length - 1);
  const relative = (key: string) => stripKeyPrefix(rootId, key);

  let loopState: Execution["loops"][string] | undefined;
  let planExecution: Execution["plans"][string] | undefined;
  for (const frame of execution.stack) {
    if (frame.kind === "loop") loopState = execution.loops[frame.key];
    if (frame.kind === "plan" && frame.mode === "execute") planExecution = execution.plans[frame.key];
  }
  const loop = loopState ? { iteration: loopState.iteration, total: loopState.items?.length ?? 0 } : undefined;
  const plan = planExecution
    ? { completed: Object.keys(planExecution.results).length, total: planExecution.plan.nodes.length }
    : undefined;

  const leaf = execution.stack[execution.stack.length - 1];
  const invocation = leaf ? execution.invocations?.[leaf.key] : undefined;
  const waiting = invocation?.status === "waiting";
  const leafCheckpoint = leaf ? execution.checkpoints[leaf.key] : undefined;

  const phases: PhaseView[] = children.map((child: Block, index: number) => {
    if (index > activeIndex) return { label: child.id, state: "pending" as const };
    if (index === activeIndex) {
      const progress = loop ? `${loop.iteration}/${loop.total}` : plan ? `${plan.completed}/${plan.total}` : undefined;
      return { label: child.id, state: "active" as const, ...(progress ? { progress } : {}) };
    }
    const checkpoint = execution.checkpoints[`${rootId}/${child.id}`];
    return checkpoint?.skipped
      ? { label: child.id, state: "skipped" as const }
      : { label: child.id, state: "complete" as const };
  });

  const entries: CompletedView[] = [];
  for (const key of execution.checkpointOrder) {
    if (key === leaf?.key) continue;
    const checkpoint = execution.checkpoints[key];
    if (checkpoint) entries.push({ label: relative(key), summary: clipText(checkpoint.summary, VIEW_LIMITS.summaryBytes) });
  }
  for (const [planKey, planned] of Object.entries(execution.plans)) {
    for (const [nodeId, result] of Object.entries(planned.results)) {
      entries.push({ label: `${relative(planKey)}/${nodeId}`, summary: clipText(result.summary, VIEW_LIMITS.summaryBytes) });
    }
  }

  return {
    workflow: workflow.title,
    runId: execution.runId,
    state: waiting ? "waiting" : "running",
    phases,
    ...(leaf
      ? {
          current: {
            path: relative(leaf.key),
            runner: invocation?.runner ?? runnerOfLeaf(workflow, leaf),
            attempt: isAttemptBearingFrame(leaf) ? leaf.attempt : 1,
            ...(loop ? { loop } : {}),
            ...(plan ? { plan } : {}),
          },
        }
      : {}),
    ...(leafCheckpoint && !leafCheckpoint.skipped
      ? { attention: clipText(leafCheckpoint.summary, VIEW_LIMITS.attentionBytes) }
      : {}),
    completed: entries.slice(-VIEW_LIMITS.completedItems),
  };
}

export type WorkflowPalette = {
  heading(text: string): string;
  muted(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
};

export function themePalette(theme: Theme): WorkflowPalette {
  return {
    heading: (text) => theme.fg("accent", text),
    muted: (text) => theme.fg("muted", text),
    accent: (text) => theme.fg("accent", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
  };
}

const identity = (text: string): string => text;
const identityPalette: WorkflowPalette = { heading: identity, muted: identity, accent: identity, success: identity, warning: identity, error: identity };

const MARKERS: Record<PhaseState, string> = { complete: "[x]", active: "[>]", skipped: "[-]", pending: "[ ]" };
const MARKER_COLORS: Record<PhaseState, keyof WorkflowPalette> = {
  complete: "success",
  active: "accent",
  skipped: "muted",
  pending: "muted",
};

function stateLabel(view: WorkflowView, palette: WorkflowPalette): string {
  return view.state === "waiting" ? palette.warning("WAITING") : palette.accent("RUNNING");
}

function headerLine(view: WorkflowView, width: number, palette: WorkflowPalette): string {
  const full = `${palette.muted("choreograph")}  ${palette.heading(view.workflow)}  ${stateLabel(view, palette)}`;
  if (visibleWidth(full) <= width) return full;
  return `${palette.heading(view.workflow)}  ${stateLabel(view, palette)}`;
}

function phaseCell(phase: PhaseView, palette: WorkflowPalette): string {
  const marker = palette[MARKER_COLORS[phase.state]](MARKERS[phase.state]);
  return `${marker} ${phase.label}${phase.progress ? ` ${phase.progress}` : ""}`;
}

/** Renders a moving neighborhood of phases around the active one on narrow terminals. */
function phaseLine(view: WorkflowView, width: number, palette: WorkflowPalette): string {
  const phases = view.phases;
  const activeIndex = phases.findIndex((phase) => phase.state === "active");
  const render = (window: readonly PhaseView[], head: string, tail: string) =>
    [head, ...window.map((phase) => phaseCell(phase, palette)), tail].filter((part) => part !== "").join("  ");
  const full = render(phases, "", "");
  if (activeIndex < 0 || visibleWidth(full) <= width) return full;
  for (let count = phases.length - 1; count >= 1; count -= 1) {
    const start = Math.max(0, Math.min(activeIndex - Math.floor((count - 1) / 2), phases.length - count));
    const window = phases.slice(start, start + count);
    const line = render(
      window,
      start > 0 ? palette.muted("...") : "",
      start + count < phases.length ? palette.muted("...") : "",
    );
    if (visibleWidth(line) <= width) return line;
  }
  return full;
}

function currentSegments(view: WorkflowView): string[] {
  const current = view.current;
  if (!current) return [];
  const segments = [current.path, current.runner, `attempt ${current.attempt}`];
  if (current.loop) segments.push(`loop ${current.loop.iteration}/${current.loop.total}`);
  if (current.plan) segments.push(`plan ${current.plan.completed}/${current.plan.total}`);
  return segments;
}

function nowLine(view: WorkflowView, width: number, palette: WorkflowPalette): string {
  const segments = currentSegments(view);
  if (segments.length === 0) return "";
  const prefix = `${palette.muted("now")} `;
  const rendered = segments.map((segment, index) => (index === 0 ? palette.heading(segment) : palette.muted(segment)));
  while (rendered.length > 1 && visibleWidth(prefix + rendered.join("  ")) > width) rendered.pop();
  return prefix + rendered.join("  ");
}

function attentionLine(view: WorkflowView, palette: WorkflowPalette): string {
  if (!view.attention || !view.current) return "";
  return `${palette.warning("[!]")} ${palette.heading(view.current.path)}: ${view.attention}`;
}

function tailLines(view: WorkflowView, attentionShown: boolean, palette: WorkflowPalette): string[] {
  const lines: string[] = [];
  if (!attentionShown && view.attention && view.current) {
    lines.push(`${palette.error("attention")} ${palette.heading(view.current.path)}: ${view.attention}`);
  }
  for (const item of view.completed) {
    if (lines.length >= 3) break;
    lines.push(`${palette.success("done")} ${palette.heading(item.label)}: ${item.summary}`);
  }
  return lines;
}

function renderRail(view: WorkflowView, detailed: boolean, width: number, palette: WorkflowPalette): string[] {
  // A parked run overrides the routine now-line with its attention reason.
  const parked = view.state === "waiting" && view.attention !== undefined;
  const lines = [headerLine(view, width, palette), phaseLine(view, width, palette), parked ? attentionLine(view, palette) : nowLine(view, width, palette)];
  return detailed ? [...lines, ...tailLines(view, parked, palette)] : lines;
}

function renderInspect(view: WorkflowView, width: number, palette: WorkflowPalette): string[] {
  const lines: string[] = [palette.muted("WORKFLOW"), `${palette.heading(view.workflow)}  ${stateLabel(view, palette)}`, palette.muted(`run ${view.runId}`), ""];
  lines.push(palette.muted("PROGRESS"));
  for (const phase of view.phases) lines.push(phaseCell(phase, palette));
  const segments = currentSegments(view);
  if (segments.length > 0) {
    lines.push("", palette.muted("NOW"), segments.map((segment, index) => (index === 0 ? palette.heading(segment) : palette.muted(segment))).join("  "));
  }
  if (view.completed.length > 0) {
    lines.push("", palette.muted("DONE"));
    for (const item of view.completed) lines.push(`${palette.heading(item.label)}: ${item.summary}`);
  }
  if (view.attention) {
    lines.push("", palette.warning("ATTENTION"), view.attention);
  }
  lines.push("", palette.muted("esc closes"));
  return lines;
}

/** One renderer for every surface; every returned line fits the supplied width. */
export function renderWorkflow(view: WorkflowView, verbosity: WorkflowVerbosity, width: number, palette: WorkflowPalette = identityPalette): string[] {
  const bounded = Math.max(width, 8);
  const lines = verbosity === "inspect" ? renderInspect(view, bounded, palette) : renderRail(view, verbosity === "detailed", bounded, palette);
  return lines.map((line) => truncateToWidth(line, bounded));
}
