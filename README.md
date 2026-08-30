# choreograph

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that runs
ordered, resumable workflows from Markdown files.

See [Architecture ownership](ARCHITECTURE.md) for the authoritative modules behind cross-package contracts.

## Why choreograph?

Pi skills provide reusable instructions, but they do not enforce an execution
order. choreograph adds an explicit workflow structure for tasks that need
repeatable stages, completion criteria, bounded tool access, and recovery from
incomplete work. Each position starts from a clean context window: a fixed
position envelope, not transcript history, carries state between positions.

A workflow combines three block types:

- **Tasks** run a specific Markdown instruction file.
- **Plans** let the model build a small dependency-ordered plan from trusted
  operator files.
- **Scripts** run one bounded local process with no model turn.

choreograph runs one position at a time. Each position records a checkpoint
before the workflow advances. Incomplete work is retried while attempts
remain, then the run parks at that position and waits for the user.

## Install

From the repository root, install the dependencies and create an extension
symlink:

```bash
npm install
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD" ~/.pi/agent/extensions/choreograph
```

The symlink points to the checkout, so future pulls do not require another
installation. Start a new Pi process after installing or updating the
extension.

## Try it without installing

Run this command from the repository root:

```bash
npm install
pi -e ./src/index.ts
```

This loads choreograph for that Pi process only.

## Quick start

Workflows live under `$PI_CODING_AGENT_DIR/workflows`. The default location is
`~/.pi/agent/workflows`.

Create a workflow with two task files:

```text
~/.pi/agent/workflows/review-change/
├── WORKFLOW.md
└── steps/
    ├── 01-inspect.md
    └── 02-report.md
```

Add this frontmatter and overview to `WORKFLOW.md`:

```markdown
---
description: Inspect a code change and report actionable findings.
piVisibility: true
legalTools: [read, grep, bash]
steps:
  - run: steps/01-inspect.md
    id: inspect
    done: [change-understood, tests-checked]
  - run: steps/02-report.md
    id: report
    done: [findings-delivered]
---

Review the requested change for correctness, regressions, and missing tests.
Prefer specific findings with file and line references.
```

Write the instructions for each stage in the two step files. Then start a new
Pi process and run:

```text
/review-change path/to/change
```

The text after the command is optional. choreograph passes it to every
position as the workflow target.

Every valid workflow gets a slash command named after its directory. When
`piVisibility` is `true`, the model can also discover and start it through the
`workflow_start` tool. Only one workflow can be active at a time.

## Workflow structure

A workflow directory has this shape:

```text
my-workflow/
├── WORKFLOW.md          # Required frontmatter and workflow overview
├── steps/               # Recommended convention
│   ├── 01-frame.md      # Task instructions
│   └── 02-deliver.md
├── contracts/           # Optional contract schemas
│   ├── finding.schema.json
│   └── verdict.schema.json
└── operators/           # Optional trusted operator registry
    ├── inspect.md
    └── trace.md
```

The workflow directory name becomes its id and slash command. It must match
`^[a-z][a-z0-9-]*$`.

Task files may use any contained `.md` path. The `steps/` directory is only a
convention. Paths cannot be absolute or escape the workflow directory through
`..` or a symlink.

The `operators/` name is enforced. choreograph reads only direct
`operators/*.md` children. It validates every discovered operator, even when a
workflow does not use it.

The `contracts/` directory is also enforced. choreograph reads only direct
`contracts/*.schema.json` children and compiles every discovered contract,
even when unused. Contract files may live elsewhere in the package when the
frontmatter `contracts:` mapping names them.

Frontmatter in task files is optional. When valid object frontmatter is
present, choreograph removes it from the instructions shown to the model.

### Workflow checking

choreograph parses and validates workflow definitions from disk
(`src/authoring/parser.ts`) with strict schemas: unknown frontmatter or step
keys are rejected loudly. Before a run starts, `freezeDefinition`
(`src/authoring/compile.ts`) reads every Markdown source and freezes its
content. The frozen definition carries a digest over the whole projection;
the run's snapshot records that digest, and resume verifies it. A workflow
edited mid-run is refused on restore.

## Workflow frontmatter

`WORKFLOW.md` must start with YAML frontmatter. Unknown fields are rejected.
The Markdown body becomes the overview shown at every workflow position.

```yaml
---
description: What this workflow does and when to use it.
piVisibility: true
legalTools: [read, grep, bash]
steps:
  - run: steps/01-frame.md
    id: frame
    done: [scope-clear]
  - id: investigate
    plan:
      operators: [inspect, trace]
      repair:
        max_attempts: 2
  - run: steps/03-deliver.md
    id: deliver
    repair:
      max_attempts: 2
  - run: steps/04-file-issues.md
    id: file-issues
    when:
      from: deliver
      select: /data/severity
      op: in
      value: [high, critical]
---
```

| Field | Required | Effect |
|---|---:|---|
| `description` | Yes | Describes the workflow in Pi and to the model. |
| `steps` | Yes | Defines a non-empty ordered list of task, plan, script, and loop blocks. |
| `piVisibility` | No | Adds the workflow to the model-facing roster and `workflow_start` tool. Defaults to `false`. |
| `legalTools` | No | Limits the Pi tools available throughout the workflow. |
| `contracts` | No | Maps contract ids to contained `contracts/*.schema.json` files. Discovery is automatic without it. |

### Task blocks

A task runs one Markdown instruction file to completion.

```yaml
- run: steps/01-inspect.md
  id: inspect
  tools: [read, grep]
  done: [implementation-checked, tests-checked]
  repair:
    max_attempts: 2
```

| Field | Required | Effect |
|---|---:|---|
| `run` | Yes | Names a contained Markdown instruction file. |
| `id` | No | Sets the block id. Otherwise the file stem is used, with a leading numeric prefix removed. |
| `tools` | No | Further limits the tools available for this task. |
| `done` | No | Lists criterion ids that a successful transition must report. |
| `repair` | No | Overrides the recovery policy: `max_attempts` from 1 to 3, default 2. |
| `inputs` | No | Binds earlier artifacts to this position; see [Artifacts and contracts](#artifacts-and-contracts). |
| `output` | No | Names the contract that `checkpoint.data` must satisfy. |
| `when` | No | Guards this task on an earlier artifact; see [Guards](#guards). |

Every block id must be unique within the workflow and match
`^[a-z][a-z0-9-]*$`.

### Loop blocks

A loop block runs one task body once per item, under a hard cap.

```yaml
- id: review-files
  for_each:
    items: { from: gather, select: /data/files }
    body:
      run: steps/review-one.md
      id: review-one
      inputs: { item: { from: "$item" } }
    maxItems: 8
```

| Field | Required | Effect |
|---|---:|---|
| `for_each` | Yes | Chooses the loop form; a step declares at most one. |
| `items` | Yes | Input binding that must resolve to a list of at most `maxItems` JSON values. Materialized once at loop start. |
| `body` | Yes | Exactly one `run` step. The body accepts `inputs` and may bind `$item`; it rejects `tools`, `done`, `output`, `plan`, `script`, and nested loops. |
| `maxItems` | Yes | Integer 1 to 8. The loop finishes when the items run out or the cap is reached. |

Each iteration writes its body checkpoint under a scoped key such as
`root/review-files/loop[2]/review-one`. On completion the loop writes one
aggregate checkpoint at its own key. The aggregate always has the same shape:

```json
{
  "mode": "for-each",
  "iterations": 3,
  "results": [{ "item": "...", "outputs": { "...": "artifact-reference" } }]
}
```

The shape never varies with output size, so a downstream consumer always knows
what a binding resolves to. Recovery is per iteration: a retry re-runs the
failed body step in place, leaving earlier iterations untouched.

### Plan blocks

A plan block asks the model to create a bounded plan from trusted operators.
The engine then runs each node in dependency order, one node per turn.

```yaml
- id: investigate
  plan:
    operators: [inspect, trace]
    repair:
      max_attempts: 2
  inputs:
    brief:
      from: observe
      select: /data/scope
```

Plan blocks accept `inputs` (bound before plan creation), `repair`, and `when`
guards. They do not accept `output`; a completed plan emits an
engine-generated aggregate artifact (see below) rather than a
contract-validated checkpoint.

Plan creation returns the plan in `checkpoint.data.plan`:

```json
{
  "version": 1,
  "nodes": [
    {
      "id": "inspect-api",
      "operator": "inspect",
      "objective": "Inspect the changed API behavior.",
      "done": ["behavior-documented"]
    },
    {
      "id": "trace-callers",
      "operator": "trace",
      "objective": "Trace affected callers.",
      "dependsOn": ["inspect-api"],
      "evidence": ["direct call sites"],
      "done": ["callers-checked"]
    }
  ]
}
```

A plan must contain 2 to 8 nodes. Node ids must be unique. Every node
requires a non-empty `done` list. Each node must use an operator allowed by
the block. Dependencies may name only earlier nodes.

### Script steps

A script step runs one bounded local process with no model turn. The runtime
spawns it, records its exit, and moves on; `workflow_transition` is rejected
at script positions.

```yaml
- id: run-tests
  script:
    argv: [npm, test]
    cwd: .
    env: { CI: "1" }
    inheritEnv: [PATH, HOME, LANG]
    timeoutMs: 120000
    acceptedExitCodes: [0]
    stdout: json            # json | text | none
    stderr: text
    maxCaptureBytes: 65536
  output: test-report       # optional contract id
```

Rules:

- `argv` is required: a non-empty list of non-empty strings. There is no shell;
  metacharacters are passed through as literal arguments.
- `cwd` is relative to the workflow directory (default `.`) and must stay
  inside it.
- `env` entries override the inherited environment. `inheritEnv` is an
  allowlist of variable names copied from the agent's environment; nothing
  else is inherited.
- `timeoutMs` must be 1000 to 600000 (default 60000). On timeout the process
  gets SIGTERM, then SIGKILL after a 5 second grace.
- `acceptedExitCodes` defaults to `[0]`; entries must be 0 to 255.
- `maxCaptureBytes` defaults to 65536 (cap 1 MiB, shared across stdout and
  stderr). Output beyond the cap is truncated and flagged in the checkpoint
  summary.
- `stdout` mode decides the checkpoint data: `json` parses stdout into the
  data, `text` stores it as `{ stdout }`, `none` stores an empty object. When
  an output would exceed the checkpoint budget, the run publishes it to the
  artifact store and keeps a reference (`json`) or a short preview plus an
  `artifact` reference (`text`). When the stored `stdout` text is a preview
  rather than the full stream, the data carries `stdoutTruncated: true`.
- `stderr` mode decides how standard error is honored. `none` (the default)
  keeps stderr diagnostic-only: captured for the run's log artifacts, never
  parsed into the data. `text` adds the captured text under the `stderr` key
  of the data; beyond the checkpoint budget it is previewed with a
  `stderrArtifact` reference (`stderrTruncated: true`). `json` parses stderr
  and stores the decoded value under `stderr`; stderr that is not valid JSON
  fails the step like invalid stdout JSON. When `stdout: json` decodes to a
  non-object while a `stderr` value or captured files exist, the data becomes
  an object with the decoded stdout under `stdout`.
- `files` optionally lists up to 4 file outputs as `{ name, path }` entries,
  with `path` relative to the script's `cwd` and inside the workflow
  directory. After an accepted exit each file is published to the run's
  artifact store (`application/octet-stream`), and the references land under
  the `files` key of the data, so downstream steps can bind them like any
  artifact reference. A capture file that cannot be read fails the step
  through its repair policy.
- Script steps accept `id`, `script`, `repair`, `when`, `inputs`, and
  `output`. They reject `run`, `tools`, `done`, `plan`, and `for_each`.
- Declared `inputs` are resolved from earlier artifacts like task inputs,
  then delivered to the process as one JSON object (plus a trailing newline)
  on stdin. There is no implicit interpolation into `argv` or `env`; a script
  that wants the values reads its stdin. The payload shares the 24 KiB
  position input budget; an oversized payload fails the step and applies
  `repair`.
- An accepted exit with output satisfying the `output` contract completes the
  step. A timeout, a rejected exit code, invalid JSON, a contract violation,
  or a spawn failure retries the step; after attempts are exhausted the run
  parks at the script position with a failure checkpoint.

### Operators

Operators are trusted definitions under `operators/`. The file stem is the
operator id. Plan creation sees only each operator's id and description. A
node's execution also receives that operator's Markdown body.

```markdown
---
description: Trace control and data flow through the relevant code.
tools: [read, grep]
---

Follow the relevant call path. Record direct evidence for each conclusion.
```

Operator frontmatter accepts `description`, optional `tools`, and optional
`output`. The operator tool list further limits the tools available while its
nodes run. `output` names the contract that each node's `checkpoint.data`
must satisfy.

## Artifacts and contracts

Contracts turn free-form checkpoints into typed artifacts. A contract is a
JSON Schema file under `contracts/`; the file stem is the contract id.
Discovery is automatic, or the frontmatter `contracts:` mapping can assign
ids to specific `contracts/*.schema.json` files.

Tasks and operators declare `output: <contract-id>`. The engine validates
`checkpoint.data` against that schema on every completion, blocked
checkpoint, and recovery checkpoint. A violation rejects the transition with
the exact schema-path errors, and restore drops a run whose persisted
artifacts no longer satisfy the current contracts.

```json
{
  "type": "object",
  "required": ["finding", "evidence"],
  "additionalProperties": false,
  "properties": {
    "finding": { "type": "string", "minLength": 1 },
    "evidence": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
    "severity": { "enum": ["low", "medium", "high"] }
  }
}
```

The accepted schema subset is `type` (single or list), `properties`,
`required`, `items`, `enum`, `const`, `additionalProperties` (boolean),
`minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`, `minimum`,
`maximum`, `oneOf` (2 to 4 branches), `title`, and `description`. Every other
keyword fails discovery, so schemas stay structural and bounded. Schemas nest
at most 8 levels and each file stays under 64 KiB.

### Input bindings

A step that consumes earlier artifacts declares `inputs` instead of relying
on checkpoint summaries:

```yaml
- run: steps/03-verify.md
  id: verify
  inputs:
    brief:
      from: observe
      select: /data/scope
    findings:
      from: investigate
      select: /nodes/0/result
```

- `from` names a block declared earlier in `steps` order.
- `select` is an RFC 6901 JSON Pointer applied to the producer's artifact.
- Task producers expose their latest checkpoint object, so `/data/...`
  narrows to the structured payload.
- Plan producers expose an engine-generated aggregate:
  `{ "version": 1, "nodes": [{ "id", "operator", "objective", "evidence"?, "result" }] }`.
  A pending node's `result` is `null`; a completed node's `result` is its
  full checkpoint.
- Loop producers expose the aggregate described above; script stdout/stderr
  files and captures bind like any artifact reference.
- A position with declared inputs receives only those artifacts; the
  prior-checkpoint summaries are still listed, but the full payloads come
  only through explicit bindings.

### Input budget

Rendered inputs share one budget of 24,576 bytes per position. The prompt
drops the largest entries first and names what was cut plus the surviving
top-level keys, so a `select` pointer can recover the missing data.
Contract-bearing node dependency data shares the same budget.

## Guards

A task or plan block may carry one `when` guard. The engine evaluates it
whenever the block becomes current: at start and after each transition. A
guard that does not hold skips the block with a synthetic `skipped`
checkpoint instead of running it.

```yaml
- run: steps/04-file-issues.md
  id: file-issues
  when:
    from: deliver
    select: /data/severity
    op: in
    value: [high, critical]
```

| Field | Required | Effect |
|---|---:|---|
| `from` | Yes | Names a block declared earlier in `steps` order. |
| `select` | No | RFC 6901 JSON Pointer into the producer's artifact. The whole artifact when omitted. |
| `op` | Yes | One of `equals`, `not-equals`, `in`, `not-in`, `exists`, `not-exists`, `gt`, `gte`, `lt`, `lte`. |
| `value` | Depends | Required by the eight value ops; forbidden for `exists` and `not-exists`. |

Evaluation rules:

- Task producers expose their latest checkpoint; plan producers expose the
  engine-generated aggregate.
- A missing producer artifact or an unresolvable pointer makes every value op
  false, including negations. Use `exists` or `not-exists` to key off
  presence.
- `equals` and `not-equals` compare canonical JSON. `in` and `not-in` test
  membership. The comparison ops require finite numbers on both sides.

A skipped block records `{ summary, skipped: true }` and never prompts. A
skipped plan block also drops its plan execution, so consumers never see a
stale aggregate.

## Recovery

A position reports incomplete work with `status: needs-work` and one or more
issues:

```json
{
  "status": "needs-work",
  "checkpoint": { "summary": "The affected callers are not yet confirmed." },
  "issues": [
    { "target": "trace-callers", "reason": "No direct call-site evidence." }
  ]
}
```

The engine retries the current position while attempts remain. Each retry
records the failed checkpoint first, so the next attempt sees the prior
attempt's summary. When attempts are exhausted, the run parks at that
position and waits for the user; `workflow_retry` resumes it. `issues` are
diagnostics for the author, not engine directives: they never rewind or
invalidate other positions.

Every block has a `max_attempts` recovery policy from 1 to 3, default 2.
Set it with `repair: { max_attempts: N }`.

## Runtime behavior

Each position must finish with one `workflow_transition` call:

```json
{
  "status": "completed",
  "met": ["scope-clear"],
  "checkpoint": {
    "summary": "The scope and affected components are confirmed.",
    "evidence": ["src/example.ts:10"]
  }
}
```

The transition schema is strict: extra properties, unknown statuses, and
malformed checkpoints are rejected with an exact error.

A completion must include every criterion from the task or plan node's `done`
list. `checkpoint.data` holds the authoring interface's structured payload:
when the position declares an `output` contract, the engine validates `data`
against it, and the position's prompt shows the schema the model must
satisfy. Positions without a contract may write any JSON value.

`workflow_abort` stops the active run. choreograph saves a snapshot before
moving between positions and resumes active runs from the current session
branch. Snapshots are written in format v7; snapshots from earlier engine
versions are not resumable. Pi shows a warning and leaves the session idle in
that case.

### Position prompts

Each position receives one fixed prompt envelope, in this order:

1. Workflow identity, run id, target, and definition digest.
2. The current position key, type, and attempt number.
3. The available controls (`workflow_transition`, `workflow_abort`) and tools.
4. The workflow overview.
5. Loop or plan context, when the position sits inside one.
6. Declared inputs, or node dependencies for plan nodes.
7. The prior attempt's checkpoint for this position, when one exists.
8. Bounded summaries of earlier checkpoints (newest first, at most 8, 1 KiB
   each, 8 KiB total).
9. The current task or node instructions.
10. The output contract and criteria.
11. The transition contract.

Data reaches a position only through its declared inputs. Summaries are
always rendered so the model knows where it is; full payloads require
bindings.

### Session rollover

After accepting a checkpoint, choreograph runs any intervening scripts,
prepares a transfer, and uses an internal command to switch Pi to a new child
session before the next model position. The final report also runs in a fresh
child session. The child session carries the authoritative `Execution`
snapshot and nothing else: no handoff capsule, no epoch projection, and no
run journal. The parent session keeps its transcript, and it cannot leak into
later provider requests. During a run, context isolation starts the live
transcript at the latest control message, which names the run id, position
key, and attempt.

The terminal child session receives a report rendered from the final
`Execution`: position history, checkpoints, and aggregated plan and loop
results.

### Tool access

choreograph starts with the tools that Pi made available at session start.
It then intersects that baseline with each configured ceiling:

1. The workflow's `legalTools` list.
2. The current task's `tools` list.
3. The current operator's `tools` list.

Active-run snapshots persist that baseline. Reloading a session restores the
run's full tool set instead of the narrowed active one.

`workflow_transition` and `workflow_abort` remain available during a run.
When the session is idle, `workflow_start` (for visible workflows) returns.
An unknown tool name has no effect and produces a warning at session start.

## Limits

choreograph enforces these main bounds:

| Data | Limit |
|---|---:|
| Workflow or instruction file | 128,000 bytes |
| Contract schema file | 64 KiB |
| Contracts per workflow | 16 |
| Inputs per position | 8 |
| Rendered input budget per position | 24 KiB |
| Prior checkpoint summaries per prompt | 8, 1 KiB each, 8 KiB total |
| Dynamic plan | 32 KiB |
| Plan nodes | 8 |
| Checkpoint summary | 4 KiB |
| Complete checkpoint | 16 KiB |
| Plan node result | 8 KiB |
| Items per loop (and cap) | 8 |
| Recovery attempts per position | 1 to 3, default 2 |
| Script argv entries | 64 |
| Script env entries | 32 |
| Script timeout | 1,000–600,000 ms |
| Script capture (stdout + stderr) | 64 KiB default, 1 MiB max |
| Total workflow memory | 512 KiB |

Workflows are ordered sequences plus dynamic plans, guards, and single-task
`for_each` loops. They do not support nested loops, unbounded `while`,
concurrency, or free-form expressions over earlier task data; use a `when`
guard for conditional steps instead.

## Development

Run the complete validation suite:

```bash
npm test
```

The command runs TypeScript in strict mode, then executes the engine,
authoring, planning, persistence, pi, runtime, and integration tests.

The project groups source by responsibility:

```text
src/
  authoring/   Workflow parsing, validation, and definition freezing
  domain/      Workflow and execution types, checkpoints, policy, limits
  engine/      Pure interpreter and recovery logic
  planning/    Dynamic plan schema and validation
  persistence/ Snapshot codec and session store
  runtime/     Tool access, prompts, delivery, context isolation, coordination
  pi/          Pi tool, command, and lifecycle registration
```

## Uninstall

Remove the extension symlink:

```bash
unlink ~/.pi/agent/extensions/choreograph
```

This leaves the repository, workflows, and saved session data untouched.
Start a new Pi process afterward.

## License

[MIT](LICENSE) (c) 2026 choreograph contributors
