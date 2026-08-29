---
cheatcodes_id: 26bb9f6eec
type: Gotcha
title: Effect and process-exit definitions are in interpreter.ts
description: The Effect union and process-exit event are defined in src/engine/interpreter.ts:31-41, not in src/domain/execution.ts.
tags:
  - code-location
  - effects
  - process-exit
status: draft
generated:
  by: cheatcodes/0.2.0
  at: 2026-08-29T20:17:13.456Z
sources:
  - id: session-e0c11f01c2803a33
    resource: session:01a0439b-cd7c-7ccb-9298-bba5301c6f75#entries=89261b59
    title: Session evidence
---

# Symptom

Searching src/domain/execution.ts for the Effect union or process-exit event does not find their definitions.

# Cause

The frame's claimed location diverges from the implementation; both definitions are in src/engine/interpreter.ts:31-41.

# Fix

Inspect src/engine/interpreter.ts:31-41 when tracing the Effect union or process-exit event.

# Evidence

- [evidence-9dfb68d5a719fe14f95562b9] Validation failed for tool "workflow_transition":
  - checkpoint: must not have additional properties

Received arguments:
{
  "checkpoint": {
    "data": {
      "deadEnds": [
        "advance cannot execute the process itself: it is pure state (no side effects anywhere in the engine), so execution must live outside it",
        "The delivered gate cannot be satisfied naturally at a script position: delivered=true is set only after prompt delivery (coordinator.ts:191, stay case); a script position never delivers, so the process-exit path needs its own gate treatment, not the model-delivery gate"
      ],
      "divergences": [
        "The frame claims Effect union and process-exit event live in src/domain/execution.ts; both actually live in src/engine/interpreter.ts:31-41. Confirmed divergence.",
        "Nothing in README or code documents script steps; the path above is design-level reconstruction, verified only at the insertion points."
      ],
      "endCondition": "One of: effe
[truncated]
