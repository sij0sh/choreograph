# Architecture ownership

This document identifies the source module for cross-package contracts. Consumers must import these contracts instead of reconstructing kind sets, field lists, or representation shapes.

## Kind taxonomies

### Execution frames

`src/domain/execution.ts` owns the `Frame` union and every frame-role projection.

- `isLeafFrame` identifies positions that accept model transitions.
- `isAttemptBearingFrame` identifies frames that carry retry attempts.
- `isStructuralFrame` identifies frames that cannot end an active restored stack.
- `isAgentDispatchFrame` identifies frames dispatched through the agent runner.
- `frameAttempt` owns the default attempt rule.

The driver projection intentionally differs from the leaf projection. A plan-execute frame is structural and is not a transition leaf, but it remains agent-dispatchable and attempt-bearing. Consumers must use the named projection that matches their behavior.

### Workflow blocks

`src/domain/workflow.ts` owns the `Block` union, `BLOCK_KIND_KEYS`, and block-role classifiers.

- `BLOCK_KIND_KEYS` owns top-level authoring-key membership.
- `src/authoring/parser.ts` owns parsing flow and error messages.
- Role classifiers stay separate from the key registry.
- README grammar remains hand-maintained documentation.

A new block kind must add one registry entry and explicit role results beside the union. Existing parser branches must not enumerate the new kind's keys as rejection lists.

## Transition shape

`src/domain/checkpoint.ts` owns `TRANSITION_SHAPE`.

The spec owns statuses, top-level fields, checkpoint fields, required fields, conditional status associations, and model-boundary exposure. `src/pi/tools.ts` derives its TypeBox enumerations from the spec. `src/runtime/prompts.ts` derives its contract enumerations from the spec. Each boundary keeps its hand-written semantic descriptions. README examples remain hand-maintained.

`Checkpoint.skipped` is an intentional divergence. The engine accepts and persists `skipped: true` for engine-generated guard skips. The model-facing `workflow_transition` schema rejects `checkpoint.skipped`, and `skipped` is not a transition status.

`TaskOutcome` remains the engine's discriminated semantic union. Runtime modules import it instead of restating its structure.

## Producer artifacts

`src/domain/artifacts.ts` owns the block-kind to artifact-source and artifact-shape dispatch. `resolveBinding` adds loud binding errors around that shared dispatch. `producerArtifact` remains total for incomplete producers. Prompt and planning consumers use exported plan-result accessors instead of probing `PlanExecution.results`.

## Persisted run state

`src/domain/execution.ts` owns the `Execution` domain type. `src/persistence/run-state-schema.ts` owns its runtime persistence field table and is compiler-linked to every `Execution` key.

`src/persistence/snapshot.ts` derives strict top-level and collection allowlists plus decoded projection from that table. `src/persistence/validate-stored-execution.ts` keeps the separate workflow-semantic validation layer. Both validation layers remain required. Unknown fields remain rejected. The active snapshot version gate remains unchanged.
