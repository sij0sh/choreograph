---
cheatcodes_id: 982aeec3db
type: Gotcha
title: Workflow blocks cannot execute scripts or child processes
description: The workflow authoring and runtime layers provide no script block or process runner, so workflows cannot launch external scripts or child processes through the current block model.
tags:
  - workflow
  - authoring
  - runtime
  - process-execution
status: draft
generated:
  by: cheatcodes/0.2.0
  at: 2026-08-29T20:24:18.125Z
sources:
  - id: session-d49e4a75f80d7e53
    resource: session:01a0439b-cd7c-7ccb-9298-bba5301c6f75#entries=bddf5b45
    title: Session evidence
  - id: session-6500216dea71627c
    resource: session:01a04a7f-5fdb-7b8e-8421-026a18cbf03b#entries=00877e8a,7532b997,714e7cda,9d76c1aa,2993861e,ddb352cd
    title: Session evidence
---

# Symptom

A workflow cannot declare or run a script or child process.

# Cause

STEP_KEYS and TaskBlock have no script key, no process-runner exists, and no spawn, child_process, or execFile usage was found in the source or package configuration.

# Fix

Add an explicitly supported script or process block to the schema and implement its runtime execution semantics before using external processes in workflows.

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

# Updates

## Addendum

### Symptom

A workflow author tries to use script or child-process behavior as a workflow block but finds no supported authoring or runtime path.

### Cause

Workflow behavior is defined by the authoring and domain block model, while process-runner coverage appears in separate runtime test and probe artifacts. Those artifacts do not establish a workflow-level block contract.

### Fix

Before relying on process execution, verify that the block is explicitly represented in the authoring model, workflow domain model, and interpreter. If it is not represented across those layers, treat it as unsupported until the complete contract and runtime semantics are added.

### Evidence

- [evidence-9189b09cd6c0a6d9af6571bd] read | repo://github.com/sij0sh/choreograph/test/runtime/process-runner.test.mjs
[truncated]
- [evidence-d7b7a1b73ad25f0a6a9b4238] read | repo://github.com/sij0sh/choreograph/test/runtime/process-runner.test.mjs
[truncated]
- [evidence-5b5cf9403009ce4d0dd832f3] 3:44:export interface WorkflowDiagnostic {
---
src/domain/workflow.ts:n {
src/au
[truncated]
- [evidence-957d1f7486e2adee96f62b34] 94:export interface Workflow {
107:const indexes = new WeakMap<Workflow, Readonl
[truncated]
- [evidence-b35ca4a42be74a8cc7e99258] read | repo://github.com/sij0sh/choreograph/src/domain/workflow.ts | 1f98e2fbe29
[truncated]
- [evidence-bfd663940c47d9e831a7d14c] read | repo://github.com/sij0sh/choreograph/.pi-files/workflow/optimization-audi
[truncated]
