import type { Run } from "../domain/run.ts";
import type { TaskOutcome } from "../engine/interpreter.ts";
import type { Workflow } from "../domain/workflow.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { DeliveryCoordinator } from "./delivery.ts";
import type { FrozenSources } from "./workflow-definition.ts";
import type { RunnerRegistry } from "./registry.ts";
import type { SettleGuard } from "./settle-guard.ts";
import type { ActiveState, PiFacade, RunState, ToolResult, UiContext } from "./types.ts";

/**
 * The coordinator surface the extracted runtime modules operate on.
 * RuntimeCoordinator satisfies it structurally via a cast; the interface
 * shrinks as simplification phases delete the underlying concerns.
 */
export interface CoordinatorInternals {
  state: RunState;
  suppressDelivery: boolean;
  readonly delivery: DeliveryCoordinator;
  readonly registry: RunnerRegistry;
  readonly pi: PiFacade;
  readonly workflows: readonly Workflow[];
  readonly frozen: FrozenSources;
  notifyCtx: { current?: UiContext };
  snapshotEntries: number | null;
  snapshotBytes: number;
  readonly snapshotByteLog: number[];
  baselineTools: string[] | null;
  isolationRunId: string | undefined;
  runtimeArtifactRoot: string | undefined;
  lastTerminal: "completed" | "aborted" | undefined;
  readonly settleGuard: SettleGuard;
  handleAgentStart(): void;
  readonly defaultArtifactRoot: string | undefined;
  now(): number;
  commit(snapshot: unknown, operation: string, options?: { readonly bypassCap?: boolean }): void;
  snapshotOf(state: ActiveState | undefined, delivered: boolean): unknown;
  artifactStoreFor(workflow: Workflow, runId: string): ArtifactStore;
  setTools(): void;
  showStatus(ctx: UiContext): void;
  adoptActive(state: ActiveState, ctx: UiContext): void;
  finishRun(current: ActiveState, ctx: UiContext, status: "completed" | "aborted", final: Run): Promise<ToolResult>;
  runTerminalExclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T>;
  supportsSessionRollover(ctx: UiContext): boolean;
  renderReport(workflow: Workflow, run: Run): string;
  requireActive(): ActiveState;
  requireAbortable(): ActiveState;
  pauseRun(ctx: UiContext): void;
  settleAgent(active: ActiveState, outcome: TaskOutcome): void;
  drive(active: ActiveState, ctx: UiContext, rerun?: boolean): Promise<Run>;
  prepareRollover(workflow: Workflow, run: Run, snapshot: unknown, terminal: boolean, ctx: UiContext): boolean;
  releaseArtifacts(runId: string): void;
  knownTools(): string[];
  isWorkflowTool(name: string): boolean;
}

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("workflow operation cancelled");
}
