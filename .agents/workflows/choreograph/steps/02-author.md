# Author

Purpose: implement the declared `specification` as a complete workflow package.
Use the specification as required data. Do not redesign from prior summaries.

## Location and package shape

Use `$PI_CODING_AGENT_DIR/workflows/<name>/`, or
`~/.pi/agent/workflows/<name>/` when the variable is unset.

```text
<name>/
|-- WORKFLOW.md
|-- steps/
|   `-- 01-task.md
|-- contracts/
|   `-- artifact.schema.json
|-- operators/
|   `-- capability.md
`-- scripts/
    `-- helper.mjs
```

Create only directories required by the selected features. Every referenced path
must be relative to the package. Paths must not use `..`, absolute paths, or
escaping symlinks. Remove stale invalid direct children from `contracts/` and
`operators/`; discovery validates them even when unused.

## Workflow frontmatter

Unknown keys are rejected.

```yaml
---
description: What the workflow does and when to use it.
piVisibility: false
legalTools: [read, grep, bash] # Optional workflow-wide ceiling
contracts:                     # Optional explicit id-to-file map
  finding: contracts/finding.schema.json
steps:
  - run: steps/01-observe.md
    id: observe
    done: [evidence-recorded]
    repair: { max_attempts: 2 }
    output: finding
---
```

Each block id must be unique. Each step must select exactly one of `run`, `plan`,
`script`, or `for_each`. An input or guard may name only an earlier top-level
block.

## Tasks

Use a task for a known model responsibility. Write a focused Markdown file.
Declare evidence-based `done` criteria. Add `tools` only to narrow the workflow
ceiling. Add `output` when machine-consumed checkpoint data needs validation.

A successful model position must make exactly one real `workflow_transition`
call and report every declared criterion id. The task should explain the exact
`checkpoint.data` shape when it has an output contract.

## Plans and operators

Use a plan only when the model must discover the investigation path at runtime.

```yaml
- id: investigate
  inputs:
    brief: { from: observe, select: /data }
  plan:
    operators: [inspect, trace]
    repair: { max_attempts: 2 }
```

Create one direct `operators/<id>.md` file for each operator:

```yaml
---
description: One precise capability for the planning model.
tools: [read, grep]
output: finding
---

# Inspect

Perform only this capability and return the contracted data.
```

Operators should not overlap. The planning position must place a version 1 plan
in `checkpoint.data.plan`. A plan has two to eight ordered nodes. Each node has a
unique id, non-empty objective, listed operator, dependencies only on earlier
nodes, and a non-empty `done` list. Nodes run in dependency order, not in
parallel. Plans cannot declare `output`; they emit
`{ version, nodes: [{ id, operator, objective, result }] }`.

## Scripts

Use a script for deterministic work that needs no model judgment.

```yaml
- id: validate-data
  script:
    argv: [node, scripts/validate.mjs]
    cwd: .
    env: { CI: "1" }
    inheritEnv: [PATH, HOME]
    timeoutMs: 60000
    acceptedExitCodes: [0]
    stdout: json
    stderr: text
    maxCaptureBytes: 65536
    files:
      - { name: report, path: out/report.json }
  inputs:
    selection: { from: choose, select: /data/items }
  repair: { max_attempts: 2 }
  output: validation-result
```

`argv` is literal and no shell is used. Inputs are one JSON object on stdin;
they are never interpolated into argv or environment values. The default cwd is
the package and cannot escape it. The process environment is empty except for
`env` and names in `inheritEnv`, so include `PATH` when command lookup needs it.

A script cannot set cwd to the user's project because cwd must stay inside the
workflow package. When it must inspect a project, bind the project path through
an earlier task and let a packaged helper read that path from stdin. Do not
assume the workflow target is interpolated into argv, cwd, or env.

`stdout` and `stderr` accept `json`, `text`, or `none`. JSON stdout becomes
checkpoint data. Text or oversized output may become an artifact reference.
Capture at most four contained files. Set an explicit timeout, accepted exits,
and capture cap when defaults are not intentional.

Timeouts, rejected exits, spawn failures, invalid JSON, missing capture files,
and contract failures use the repair policy and then park. Make scripts
idempotent because execution is at least once. Script positions reject
`workflow_transition`.

## Loops

Use a loop for independent homogeneous work over a bounded list.

```yaml
- id: review-files
  for_each:
    items: { from: gather, select: /data/files }
    body:
      run: steps/review-one.md
      inputs:
        item: { from: "$item" }
    maxItems: 8
```

The body accepts only `run` and `inputs`. Its id is derived from the task file
stem after removal of a leading numeric prefix. Do not put `id`, `tools`, `done`,
`output`, `repair`, a plan, a script, or another loop in the body.

The list is materialized once. An empty list succeeds. A list larger than
`maxItems` fails before iteration; it is not truncated. Each iteration gets a
fresh context. The aggregate is:

```json
{
  "mode": "for-each",
  "iterations": 1,
  "results": [
    {
      "iteration": 1,
      "item": {},
      "outputs": { "review-one": { "invocationKey": "...", "output": "...", "checksum": "...", "size": 1, "mediaType": "application/json" } }
    }
  ]
}
```

Body checkpoint data is stored as an artifact reference. A body checkpoint with
no data creates no output entry. Downstream work should bind only the aggregate
fields it needs.

## Contracts and inputs

Put JSON Schema files directly under `contracts/`. Omit the frontmatter
`contracts` map to use each file stem as its id. When the map is present, list
every discovered schema file. Reuse a contract only when the data shape is the
same.

Use only `type`, `properties`, `required`, `items`, `enum`, `const`,
`additionalProperties` as a boolean, `minItems`, `maxItems`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `oneOf` with two to four branches,
`title`, and `description`. Schemas may nest to eight levels. Prefer `required`
and `additionalProperties: false` for stable handoffs.

Contracts validate completed, blocked, and recovery checkpoint data. Therefore,
make the task able to emit contract-valid diagnostic data for non-success
transitions, or use a schema branch that explicitly supports that state.

Bind every required artifact. Summaries are orientation only.

```yaml
inputs:
  scope: { from: observe, select: /data/scope }
```

A position accepts at most eight inputs under one 24 KiB rendered budget. Use
JSON Pointers to avoid oversized prompts. Model inputs report missing or omitted
values; unresolved script inputs park before process spawn.

## Guards

Tasks, plans, scripts, and loops may have one top-level `when` guard.

```yaml
when:
  from: triage
  select: /data/severity
  op: in
  value: [high, critical]
```

The operators are `equals`, `not-equals`, `in`, `not-in`, `exists`,
`not-exists`, `gt`, `gte`, `lt`, and `lte`. A valid false comparison creates a
synthetic skipped checkpoint. A missing operand used by a value comparison is a
configuration error. Numeric operators also reject non-numeric operands. Use
`exists` or `not-exists` when absence is expected. Do not duplicate the guard as
a prose decision in the task.

## Recovery, tools, and visibility

Task and script repair belongs at block level. Plan repair belongs inside
`plan`. `max_attempts` ranges from 1 to 3 and defaults to 2. A loop has no repair
field; recovery applies to its current body iteration under the body default.
`needs-work` retries until exhausted. `blocked` parks immediately. The current
`workflow_retry` tool retries parked scripts only, so do not promise generic
manual retry for parked model positions.

Tool ceilings intersect the Pi session set, workflow `legalTools`, and task or
operator `tools`. A narrower scope cannot restore a removed tool. Omit a ceiling
when full access is intentional. Scripts do not use Pi tools.

Leave `piVisibility: false` for direct slash-command use. Set it to true only
when the model should see the workflow roster and may start this workflow after
a user request.

## Author checkpoint data

After writing every file, complete with:

```json
{
  "name": "workflow-name",
  "packagePath": "/absolute/path/to/workflow-name",
  "command": "/workflow-name",
  "files": ["WORKFLOW.md", "steps/01-task.md"],
  "featuresUsed": ["task", "contract", "input-binding"]
}
```

List paths relative to the new package. Include only features whose
`featureDecisions.use` value is true.

## Done when

- `package-written`: Every referenced file exists and the checkpoint lists it.
- `paths-contained`: Every authored path stays inside the package.
- `design-implemented`: The files implement every selected feature and omit every rejected feature unless the specification required it indirectly.
