import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { RuntimeCoordinator } from "../runtime/coordinator.ts";
import { renderWorkflow, themePalette, type WorkflowPalette, type WorkflowView } from "../runtime/workflow-ui.ts";

/** Right sidecar on wide terminals; a centered near-full-width panel otherwise. */
export function inspectorOverlayOptions(termWidth: number): OverlayOptions {
  if (termWidth >= 100) return { anchor: "right-center", width: 44, margin: { right: 1 }, maxHeight: "90%" };
  const width = Math.min(Math.max(termWidth - 2, 24), 64);
  return { anchor: "center", width, maxHeight: "90%" };
}

/** Bordered snapshot panel; closes on Escape or Ctrl+C. */
class WorkflowInspectorComponent implements Component {
  private readonly view: WorkflowView;
  private readonly palette: WorkflowPalette;
  private readonly done: () => void;

  constructor(view: WorkflowView, palette: WorkflowPalette, done: () => void) {
    this.view = view;
    this.palette = palette;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(width - 4, 12);
    const content = renderWorkflow(this.view, "inspect", innerWidth, this.palette);
    const border = `+${"-".repeat(innerWidth + 2)}+`;
    return [
      border,
      ...content.map((line) => `| ${line}${" ".repeat(Math.max(innerWidth - visibleWidth(line), 0))} |`),
      border,
    ];
  }

  invalidate(): void {}
}

export async function inspectWorkflow(runtime: RuntimeCoordinator, ctx: ExtensionCommandContext): Promise<void> {
  const view = runtime.activeWorkflowView();
  if (!view) {
    ctx.ui.notify("No active workflow run.", "info");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify(renderWorkflow(view, "inspect", 96).join("\n"), "info");
    return;
  }
  let termWidth = 80;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    termWidth = tui.terminal.columns;
    return new WorkflowInspectorComponent(view, themePalette(theme), done);
  }, {
    overlay: true,
    overlayOptions: () => inspectorOverlayOptions(termWidth),
  });
}
