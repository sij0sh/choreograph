# Architecture ownership

This document identifies the source module for cross-package contracts. Consumers must import these contracts instead of reconstructing kind sets, field lists, or representation shapes.

The code uses one name per boundary concept. The glossary in [WORKFLOW_REFERENCE.md](WORKFLOW_REFERENCE.md#vocabulary) defines workflow, definition, run, step, position, invocation, and checkpoint.

## Engine modules

`src/engine/interpreter.ts` owns the transition core: `start`, `transition`, `advance`, and the effect union. It re-exports `TaskOutcome` and `Issue` for its existing consumers.

`src/engine/outcome.ts` owns the `TaskOutcome` union, `Issue`, and outcome validation.

`src/engine/progress.ts` owns stack progression: block push, guard skip, loop finish, and checkpoint commits.

`src/engine/position.ts` owns `currentPosition`, the ephemeral position projection.

## Kind sets

### Run frames

`src/domain/run.ts` owns the `Frame` union and every frame-role projection.

- `isLeafFrame` identifies positions that accept model transitions.
- `isAttemptBearingFrame` identifies frames that carry retry attempts.
- `isStructuralFrame` identifies frames that cannot end an active restored stack.
- `isAgentDispatchFrame` identifies frames dispatched through the agent runner.
- `frameAttempt` owns the default attempt rule.

The driver projection intentionally differs from the leaf projection. A plan-execute frame is structural and is not a transition leaf, but it remains agent-dispatchable and attempt-bearing. Consumers must use the named projection that matches their behavior.

### Workflow blocks

`src/domain/workflow.ts` owns the `Block` union, `BLOCK_KIND_KEYS`, and block-role classifiers.

- `BLOCK_KIND_KEYS` owns top-level authoring-key membership, and `BLOCK_KIND_DISCRIMINATORS` owns the per-kind selecting key (compile-linked to those key lists). The parser derives its rejection logic and kind selection from them.
- `instructionFileOf` answers which blocks contribute instruction files; `scriptCwdOf` answers which blocks declare a script working directory; `isToolsBearingBlock` answers which blocks may declare a tools list. Consumers query these projections instead of restating kind checks.
- `src/authoring/parser.ts` owns parsing flow and error messages.
- Role classifiers stay separate from the key registry.
- README grammar remains hand-maintained documentation.

A new block kind must add one registry entry and explicit role results beside the union. Existing parser branches must not enumerate the new kind's keys as rejection lists.

## Transition shape

`src/domain/checkpoint.ts` owns `TRANSITION_SHAPE`.

The spec owns statuses, top-level fields, checkpoint fields, required fields, conditional status associations, and model-boundary exposure. `src/pi/tools.ts` derives its TypeBox enumerations from the spec. `src/runtime/prompts.ts` derives its contract enumerations from the spec. Each boundary keeps its hand-written semantic descriptions. README examples remain hand-maintained.

`Checkpoint.skipped` is an intentional divergence. The engine accepts and persists `skipped: true` for engine-generated guard skips. The model-facing `workflow_transition` schema rejects `checkpoint.skipped`, and `skipped` is not a transition status.

`src/engine/outcome.ts` owns `TaskOutcome`, the engine's discriminated semantic union. `src/engine/interpreter.ts` re-exports it. Runtime modules import it instead of restating its structure.

`src/engine/outcome.ts` owns `TaskOutcome`, the engine's discriminated semantic union. `src/engine/interpreter.ts` re-exports it. Runtime modules import it instead of restating its structure.

## Runner routing

`src/engine/interpreter.ts` owns the leaf-to-runner classification (`runnerOfLeaf`); no other module defines it. Each runner declares its execution mode (`executesOn: "model" | "runtime"`), and `RunnerRegistry.executesCurrentLeaf` answers whether the run's current leaf executes in the runtime from those declarations - never from a runner-kind list. The workflow UI derives runner identity from the classifier or the persisted invocation, and its view type uses `RunnerKind`, not literal runner unions. `processLeafAt` stays the script-leaf payload for the driver's dispatch.

## Run lifecycle

`src/domain/run.ts` owns `RunLifecycleStatus` and the lifecycle roles table (`lifecycleRoles`): the live and abortable answers per status. `src/runtime/types.ts` maps the coordinator's `RunState` onto that table (`runStateRoles`, `liveRunState`, `runPayloadState`); runtime modules ask those helpers instead of comparing run-state status literals, and the session-lifecycle vocabulary never appears below the runtime layer.

A paused run is a session-level park: the engine's `Run.status` never holds `paused`. `src/persistence/snapshot.ts` owns the paused snapshot record, its parse row in the status decoder table (a lifecycle status without a parse row fails compilation), and the O(1) pause marker; `src/persistence/store.ts` folds markers into paused records the way it folds delivered tombstones. `/workflow-resume` owns the in-session resume.

## Runtime concerns

Each coordinator runtime concern owns its state and reset policy as a collaborator (the `DeliveryCoordinator` pattern): the settle guard owns its episode counters in `src/runtime/settle-guard.ts` and hosts call `reset()` / `note*()` instead of assigning concern fields. The shared `CoordinatorInternals` delegate interface shrinks as concerns become self-contained; its member count is pinned non-increasing in the ownership test. Remaining flat concerns (terminal bookkeeping, delivery suppression, snapshot accounting) migrate one concern per change, deleting each field's consumer wiring as it moves.

## Producer artifacts

`src/domain/artifacts.ts` owns the block-kind to artifact-source and artifact-shape dispatch. `resolveBinding` adds loud binding errors around that shared dispatch. `producerArtifact` remains total for incomplete producers. Prompt and planning consumers use exported plan-result accessors instead of probing `PlanRecord.results`.

## Persisted run state

`src/domain/run.ts` owns the `Run` domain type. `src/persistence/run-state-schema.ts` owns its runtime persistence field table and is compiler-linked to every `Run` key.

`src/persistence/snapshot.ts` derives strict top-level and collection allowlists plus decoded projection from that table. Its decode allowlists (`NODE_STATUSES`, `RUNNER_KINDS`, `FRAME_DECODERS`) are exhaustiveness-linked to the domain unions they admit: a stale list or a new union member without a decode entry fails compilation, and the member sets are pinned in the ownership test. `src/persistence/validate-stored-run.ts` keeps the separate workflow-semantic validation layer. Both validation layers stay required. Unknown fields are still rejected. The active snapshot version gate is unchanged.

The workflow UI (`src/runtime/workflow-ui.ts`) is an ephemeral derivation of `Workflow` and `Run` and is never persisted.
