import type { Execution } from "../domain/execution.ts";
import type { Workflow } from "../domain/workflow.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { DeliveryCoordinator } from "./delivery.ts";
import type { HandoffManifestV1 } from "../domain/handoff.ts";
import type { RunnerRegistry } from "./registry.ts";
import type { RolloverTransferV1 } from "./transfer.ts";
import type { ActiveState, PiFacade, RunState, ToolResult, UiContext } from "./coordinator.ts";

/**
 * The coordinator surface the extracted execution driver and rollover modules
 * operate on. RuntimeCoordinator satisfies it structurally via a cast; the
 * interface shrinks as simplification phases delete the underlying concerns.
 */
export interface CoordinatorInternals {
  state: RunState;
  readonly suppressDelivery: boolean;
  readonly delivery: DeliveryCoordinator;
  readonly registry: RunnerRegistry;
  readonly pi: PiFacade;
  readonly handoffs: Map<string, HandoffManifestV1>;
  readonly workflows: readonly Workflow[];
  now(): number;
  commit(snapshot: unknown, operation: string): void;
  snapshotOf(state: ActiveState | undefined, delivered: boolean, handoff?: HandoffManifestV1): unknown;
  artifactStoreFor(workflow: Workflow, runId: string): ArtifactStore;
  processHandoffManifest(state: ActiveState, previous: Execution, next: Execution): HandoffManifestV1;
  persistManifest(manifest: HandoffManifestV1): void;
  setTools(): void;
  showStatus(ctx: UiContext): void;
  adoptActive(state: ActiveState, ctx: UiContext): void;
  finishRun(current: ActiveState, ctx: UiContext, status: "completed" | "aborted", final: Execution): Promise<ToolResult>;
  supportsSessionRollover(ctx: UiContext): boolean;
}
