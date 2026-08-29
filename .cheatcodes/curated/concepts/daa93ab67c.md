---
cheatcodes_id: daa93ab67c
type: Gotcha
title: Script-step behavior is not documented
description: Neither the README nor the code documents script steps; the described path is a design-level reconstruction verified only at insertion points.
tags:
  - documentation
  - script-steps
  - verification
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

Script-step behavior cannot be confirmed from the README or existing code documentation.

# Cause

Script steps are undocumented, so the path is reconstructed at the relevant insertion points rather than established by project documentation.

# Fix

Treat script-step behavior as a reconstruction requiring verification at the insertion points before relying on it.

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
