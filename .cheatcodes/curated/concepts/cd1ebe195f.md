---
cheatcodes_id: cd1ebe195f
type: Gotcha
title: Terminal completion drops final run state
description: Completed runs are persisted as bare terminal snapshots without result.state, and restoring a run ignores non-active snapshots, so final state is not available after completion or reload.
tags:
  - runtime
  - persistence
  - terminal-state
status: draft
generated:
  by: cheatcodes/0.2.0
  at: 2026-08-29T20:15:04.305Z
sources:
  - id: session-d49e4a75f80d7e53
    resource: session:01a0439b-cd7c-7ccb-9298-bba5301c6f75#entries=bddf5b45
    title: Session evidence
---

# Symptom

A completed run has terminal status but its final state is not persisted or restored.

# Cause

finishRun calls terminalSnapshot(workflow, runId) without result.state; terminal snapshots contain only version, status, workflow, and runId, and restoreRun ignores non-active snapshots.

# Fix

Persist the completion result state in terminal snapshots and restore terminal state when reloading completed runs.

# Evidence

- [evidence-d0215080277f0bba9d90a10f] Validation failed for tool "workflow_transition":
  - checkpoint: must not have additional properties

Received arguments:
{
  "checkpoint": {
    "evidence": [
      "src/runtime/coordinator.ts:188,225-227,261 — finishRun commits terminalSnapshot(workflow, runId) only; completion path drops result.state",
      "src/persistence/snapshot.ts:262-269 — TerminalSnapshot/terminalSnapshot return {v:5,status,workflow,runId}; parseSnapshot maps terminal to {status:\"terminal\"} and restoreRun ignores non-active",
      "test/runtime/coordinator.test.mjs:271,258 — existing tests assert bare-terminal behavior only; no final-state persistence or reload-idle test",
      "src/authoring/schema.ts:8 + src/domain/workflow.ts:12-22 — STEP_KEYS and TaskBlock have no script key; grep finds no spawn/child_process/execFile in src or package.json and no src/runtime/process-runner.ts",
      "src/engine/interpreter.ts:30-35,117 — Effect is deliver|stay|complete|aborted; unknown block kinds rejected as unsu
[truncated]
