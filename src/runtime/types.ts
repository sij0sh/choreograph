import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Run } from "../domain/run.ts";
import type { Workflow } from "../domain/workflow.ts";
import type { RolloverTransferV2 } from "./transfer.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}

export type PiFacade = {
  getActiveTools(): string[];
  getAllTools?: () => readonly { name: string }[];
  setActiveTools(names: string[]): void;
  appendEntry(type: string, data: unknown): void;
  sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
};

export type WidgetContent = string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void });

export type UiContext = {
  ui: {
    setStatus(id: string, value: string | undefined): void;
    setWidget?(id: string, content: WidgetContent | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    notify(message: string, level: "info" | "error" | "warning"): void;
  };
  cwd?: string;
  model?: { contextWindow?: number; maxTokens?: number };
  getSystemPrompt?(): string;
  sessionManager?: {
    getBranch(): unknown[];
    getSessionFile?(): string | undefined;
    getSessionDir?(): string;
    getCwd?(): string;
  };
};

export type ActiveState = {
  status: "active";
  workflow: Workflow;
  execution: Run;
  delivered: boolean;
};

export type RunState = { status: "idle" } | ActiveState | { status: "rollover-pending"; transfer: RolloverTransferV2 };
