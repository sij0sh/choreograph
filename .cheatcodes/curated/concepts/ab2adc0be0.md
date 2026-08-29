---
cheatcodes_id: ab2adc0be0
type: Gotcha
title: Script bodies and workflow transitions are constrained by engine validation
description: Script steps cannot be nested in loop bodies or transitioned through as ordinary leaf frames.
tags:
  - validation
  - scripts
  - workflow
status: draft
generated:
  by: cheatcodes/0.2.0
  at: 2026-08-29T20:19:07.569Z
sources:
  - id: session-8556a9b38219e35c
    resource: session:01a043d9-5751-75e6-bf8c-d31517036ffe#entries=14b8fd7e
    title: Session evidence
---

# Symptom

A script is placed inside a loop body or workflow_transition is attempted while the current position is a script.

# Cause

parseBodyStep rejects non-run body keys, making script-in-loop impossible, and the engine transition rejects workflow_transition at a script position through isLeafFrame.

# Fix

Keep script steps outside loop bodies and route script completion through the existing engine effect/transition path rather than invoking workflow_transition directly from a script position.

# Evidence

- [evidence-12a7dbac3bd9e3114ec7b172] Validation failed for tool "workflow_transition":
  - checkpoint.summary: must have required properties summary

Received arguments:
{
  "checkpoint": {
    "data": {
      "plan-corrections": [
        "Effect union location: src/engine/interpreter.ts:30 (plan says domain/execution.ts)",
        "WorkflowEvent location: src/engine/interpreter.ts:26, unexported but structurally usable",
        "Script-in-loop: impossible already; parseBodyStep rejects non-run body keys",
        "workflow_transition at script position: rejected by isLeafFrame check in engine transition"
      ],
      "claim": "Phase 2 script steps integrate through the existing engine effect/transition path with no new agent-turn machinery.",
      "prediction": "If true: (1) Effect union and WorkflowEvent are extensible; (2) advance() has an insertion point where a script frame can return a new run-process effect; (3) the coordinator can apply a synthetic process-exit event through engineTransition and only prompt o
[truncated]
