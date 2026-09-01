# Workflow reference

This reference documents Choreograph workflow files and runtime limits. Start
with the authoring workflow in the [README](README.md#3-author-a-workflow).
Use this document when reviewing generated files or authoring a package by
hand.

## Vocabulary

One name for each concept, in code and in these documents:

| Term | Meaning |
| --- | --- |
| Workflow | The thing the user authors: a `WORKFLOW.md` package under a discovery root. |
| Definition | The workflow's frozen compiled representation (`WorkflowDefinition`), fixed by a content digest. |
| Run | One execution of a workflow, identified by its `runId`. |
| Step | A declared unit in the authored tree: a task, script, plan, loop, or sequence block. |
| Position | The site the model currently occupies. One key addresses one position; a retry re-enters the same position with a higher attempt. |
| Invocation | One actual attempt to execute a position. It records the runner, the status, and the attempt number. |
| Checkpoint | The durable result committed at a boundary. |

## Discovery and layout

Choreograph discovers direct child directories under two roots: the global
root `$PI_CODING_AGENT_DIR/workflows` (default `~/.pi/agent/workflows`) and
the project-local root `<project>/.agents/workflows`, where `<project>` is
the directory Pi starts in. A local workflow overrides a global workflow with
the same name. The directory name is both the workflow id and its
slash command. It must match `^[a-z][a-z0-9-]*$`.

```text
my-workflow/
├── WORKFLOW.md          # Required frontmatter and overview
├── steps/               # Convention only; any contained .md path works
├── contracts/           # Optional JSON Schema files
└── operators/           # Optional trusted operator registry
```

`operators/` and `contracts/` are enforced names. Choreograph reads only
direct children and validates every discovered file, including unused files.
Referenced paths cannot escape the workflow directory through `..`, absolute
paths, or symlinks.

## WORKFLOW.md frontmatter

`WORKFLOW.md` starts with YAML frontmatter. Unknown fields are rejected. The
Markdown body becomes the workflow overview shown at every model position.

```yaml
---
description: Inspect a code change and report actionable findings.
piVisibility: false
legalTools: [read, grep, bash]
contracts:
  finding: contracts/finding.schema.json
steps:
  - run: steps/01-frame.md
    id: frame
    done: [scope-clear]
  - id: investigate
    plan:
      operators: [inspect, trace]
  - run: steps/03-deliver.md
    id: deliver
    when:
      from: frame
      select: /data/scope
      op: exists
---

# Review a change

Keep findings concrete, evidenced, and actionable.
```

| Field | Required | Effect |
|---|---:|---|
| `description` | Yes | Describes the workflow in Pi and to the model. |
| `steps` | Yes | Defines a non-empty ordered list of task, plan, script, and loop blocks. |
| `piVisibility` | No | Adds the workflow to the model-facing roster and `workflow_start`. Default `false`. |
| `legalTools` | No | Limits Pi tools across the workflow. Omit it to retain the session tool set. |
| `contracts` | No | Maps contract ids to contained schema files. Contract discovery is automatic without it. |

Block ids must be unique within the workflow and use lowercase kebab-case.
Each `steps` entry must select exactly one block kind: `run`, `plan`, `script`,
or `for_each`.

## Task blocks

A task runs one Markdown instruction file as one model position.

```yaml
- run: steps/01-frame.md
  id: frame
  tools: [read, grep]
  done: [scope-clear, evidence-recorded]
  repair: { max_attempts: 2 }
  inputs:
    brief: { from: intake, select: /data/brief }
  output: finding
  when:
    from: intake
    select: /data/ready
    op: equals
    value: true
```

| Field | Required | Effect |
|---|---:|---|
| `run` | Yes | Names a contained Markdown instruction file. |
| `id` | No | Defaults to the file stem after removal of a leading numeric prefix. |
| `tools` | No | Narrows the available tools for this task. |
| `done` | No | Lists criterion ids that a successful transition must report. |
| `repair` | No | Sets `{ max_attempts: 1..3 }`. The default is 2. |
| `inputs` | No | Binds declared artifacts from earlier blocks. |
| `output` | No | Names the contract for `checkpoint.data`. |
| `when` | No | Guards the task using an earlier artifact. |

## Plan blocks

A plan asks the model to build 2 to 8 nodes from a declared operator set. The
engine runs each node in dependency order. Each node becomes a separate model
position and must declare a non-empty `done` list. A node may depend only on
nodes declared before it.

```yaml
- id: investigate
  inputs:
    brief: { from: frame, select: /data }
  plan:
    operators: [inspect, trace]
    repair: { max_attempts: 2 }
```

A plan block accepts `id`, `inputs`, `repair`, and `when`. It rejects `output`
because the engine emits this aggregate:

```json
{
  "version": 1,
  "nodes": [
    { "id": "inspect-entry", "operator": "inspect", "objective": "...", "result": {} }
  ]
}
```

A pending node has a `null` result.

## Operator files

Plans may use only operators named in `plan.operators`. Each operator is a
direct child Markdown file under `operators/`. Its file stem is its id.

```yaml
---
description: Trace control and data flow through the relevant path.
tools: [read, grep]
output: finding
---

# Trace

Follow the relevant path and return evidenced findings.
```

| Field | Required | Effect |
|---|---:|---|
| `description` | Yes | Explains the capability to the planning model. |
| `tools` | No | Narrows tools while this operator runs. |
| `output` | No | Names the contract for the operator checkpoint data. |

Every operator listed by a plan must have a corresponding file.

## Script blocks

A script block runs one bounded local process without a model position.

```yaml
- id: run-tests
  script:
    argv: [npm, test]
    cwd: .
    env: { CI: "1" }
    inheritEnv: [PATH, HOME]
    timeoutMs: 120000
    acceptedExitCodes: [0]
    stdout: json
    stderr: text
    maxCaptureBytes: 65536
    files:
      - { name: log, path: out/log.txt }
  inputs:
    selection: { from: frame, select: /data/files }
  repair: { max_attempts: 2 }
  output: test-report
```

| Script field | Required | Effect |
|---|---:|---|
| `argv` | Yes | Supplies literal executable arguments. No shell is used. |
| `cwd` | No | Sets a contained working directory. Default `.`. |
| `env` | No | Supplies up to 32 environment overrides. |
| `inheritEnv` | No | Allowlists inherited environment variables. |
| `timeoutMs` | No | Sets 1,000-600,000 ms. Default 60,000. |
| `acceptedExitCodes` | No | Defines successful exit codes. Default `[0]`. |
| `stdout` | No | Captures `json`, `text`, or `none`. |
| `stderr` | No | Captures `json`, `text`, or `none`. |
| `maxCaptureBytes` | No | Caps combined stdout and stderr. Default 64 KiB; maximum 1 MiB. |
| `files` | No | Captures up to four named, contained files. |

Script blocks accept `id`, `script`, `repair`, `when`, `inputs`, and `output`.
They reject `run`, `tools`, `done`, and `plan`.

Declared inputs arrive on stdin as one JSON object under the 24 KiB input
budget. They are never interpolated into `argv` or `env`. When `stdout` is
`json`, parsed stdout becomes `checkpoint.data`. Stdout keys take precedence
over runtime side keys such as `stderr` and `files`.

On timeout, Choreograph sends SIGTERM, waits five seconds, sends SIGKILL, and
allows one second to drain output. The deadline is absolute from process
spawn. A timeout, rejected exit code, invalid JSON, contract violation, or
spawn failure follows the block's repair policy. Exhausted attempts park the
run.

## Loop blocks

A loop materializes a list once, then runs one task body per item.

```yaml
- id: review-files
  for_each:
    items: { from: gather, select: /data/files }
    body:
      run: steps/review-one.md
      id: review-one
      inputs:
        item: { from: "$item" }
    maxItems: 8
```

`items` must resolve to a list. `maxItems` is required and ranges from 1 to 8.
The body contains exactly one `run` task. It may bind `$item`. It rejects
`tools`, `done`, `output`, `plan`, `script`, and nested loops.

Recovery applies to the current iteration. Earlier iteration results remain
unchanged. The completed loop emits:

```json
{
  "mode": "for-each",
  "iterations": 2,
  "results": [
    { "item": "src/a.ts", "outputs": {} }
  ]
}
```

## Contracts

Contracts are JSON Schema files under `contracts/`. The file stem becomes the
contract id unless the workflow frontmatter maps an id explicitly. Tasks,
scripts, and operators attach a contract with `output: <contract-id>`.
Choreograph validates `checkpoint.data` on completion, blocked, and recovery
checkpoints.

```json
{
  "type": "object",
  "required": ["finding", "evidence"],
  "additionalProperties": false,
  "properties": {
    "finding": { "type": "string", "minLength": 1 },
    "evidence": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 8
    },
    "severity": { "enum": ["low", "medium", "high"] }
  }
}
```

Accepted keywords are:

* `type`, as one type or a list
* `properties`, `required`, and `additionalProperties` as a boolean
* `items`, `minItems`, and `maxItems`
* `minLength`, `maxLength`, and `pattern`
* `minimum` and `maximum`
* `enum` and `const`
* `oneOf` with 2 to 4 branches
* `title` and `description`

Schemas may nest at most eight levels and must stay under 64 KiB. Every
discovered contract compiles during discovery, even when no block uses it.

## Input bindings

An input binding names an earlier producer and may select part of its artifact
with an RFC 6901 JSON Pointer.

```yaml
inputs:
  brief: { from: observe, select: /data/scope }
  findings: { from: investigate, select: /nodes/0/result }
```

`from` must name a block declared earlier in `steps` order. Task and script
producers expose their latest checkpoint. Plan and loop producers expose their
engine-generated aggregates. Bind every artifact a step needs. Checkpoint
summaries are for orientation. They do not carry data between steps.

A position accepts at most eight inputs under a shared 24 KiB rendered budget.
If the budget is exceeded, the prompt drops the largest entries first and
names each omitted entry.

## Guards

Tasks, plans, and scripts may carry one `when` guard. The engine evaluates the
guard when the block becomes current. A false guard records a synthetic
`skipped` checkpoint instead of asking the model to invent a completion.

```yaml
when:
  from: triage
  select: /data/severity
  op: in
  value: [high, critical]
```

| Field | Required | Effect |
|---|---:|---|
| `from` | Yes | Names an earlier block in `steps` order. |
| `select` | No | Selects a JSON Pointer within the producer artifact. |
| `op` | Yes | Selects a closed comparison operator. |
| `value` | Depends | Is required by value operators and forbidden for existence operators. |

Operators are `equals`, `not-equals`, `in`, `not-in`, `exists`, `not-exists`,
`gt`, `gte`, `lt`, and `lte`.

`equals` and `not-equals` take a scalar. `in` and `not-in` take a non-empty
scalar list. Numeric comparisons take a finite number. `exists` and
`not-exists` take no value. A missing artifact or unresolvable pointer makes a
value comparison false, including negative comparisons. Use the existence
operators when presence itself controls the branch.

## Repair and transitions

Each model position ends with one `workflow_transition` tool call. The call
must copy the position `key` exactly. The transition schema rejects extra
properties, unknown statuses, malformed checkpoints, stale positions, and
replayed positions.

A successful transition must report every criterion id declared by `done`.
Structured checkpoint data must satisfy the block or operator output contract.
Incomplete work reports `needs-work` with diagnostic `issues[]`.

`repair.max_attempts` ranges from 1 to 3 and defaults to 2. Choreograph retries
the current position until attempts are exhausted. It then parks the run for
inspection. Ask the agent to call `workflow_retry` after addressing the
reported issues, or `workflow_abort` to stop the run. Retry is rejected while
a script process is still active.

## Tool ceilings

Tools begin with the Pi session's baseline tool set. Choreograph intersects
that set with workflow `legalTools`, task `tools`, and operator `tools` where
each is present. A narrower scope cannot re-enable a tool removed by a broader
scope. `workflow_transition` and `workflow_abort` remain available during a
model position.

Unknown tool names produce a warning at session start. Remove the name or
enable that tool in Pi.

## Persistence and runtime rules

* Choreograph snapshots before advancing to the next position.
* Only snapshot format v7 can resume. Earlier formats are rejected.
* A workflow content digest prevents resume after its files change mid-run.
* Three model replies without a `workflow_transition` call trigger settle
  guard nudges and then stall the run.
* Only one workflow can be active in a Pi session.
* A workflow target is optional and reaches every model position.
* Workflows do not support nested loops, unbounded `while`, concurrency, or
  free-form expressions.

## Limits

| Data | Limit |
|---|---:|
| Workflow or instruction file | 128,000 bytes |
| Contract schema file / count | 64 KiB / 16 per workflow |
| Inputs per position / budget | 8 / 24 KiB |
| Prior checkpoint summaries | 8, 1 KiB each, 8 KiB total |
| Plan nodes / plan size | 8 / 32 KiB |
| Checkpoint summary / complete | 4 KiB / 16 KiB |
| Loop items | 8 |
| Recovery attempts | 1-3, default 2 |
| Settle-guard nudges | 3 |
| Script argv / environment entries | 64 / 32 |
| Script timeout | 1,000-600,000 ms |
| Script capture | 64 KiB default, 1 MiB maximum |
| Snapshot entries / bytes per session | 256 / 16 MiB |
| Run artifact retention | 20 runs / 256 MiB, oldest first |
| Materialized copies | 64 MiB with 10 minute grace |
| Total workflow memory | 512 KiB |
