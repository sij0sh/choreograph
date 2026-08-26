# choreograph

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that runs
ordered, resumable workflows from Markdown files.

## Why choreograph?

Pi skills provide reusable instructions, but they do not enforce an execution
order. choreograph adds an explicit workflow structure for tasks that need
repeatable stages, completion criteria, bounded tool access, and recovery from
incomplete work. Each position also starts from a clean context window:
checkpoints, not transcript history, carry state between positions.

A workflow can combine two block types:

- **Tasks** run a specific Markdown instruction file.
- **Plans** let the model build a small dependency-ordered plan from trusted
  operator files.

choreograph runs one position at a time. Each position records a checkpoint
before the workflow advances. If work is incomplete, a recovery policy can
retry it, invalidate affected results, replan, or stop for user input.

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
        max_replans: 2
  - run: steps/03-deliver.md
    id: deliver
    repair:
      strategy: [invalidate, block]
      scope: investigate
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
| `steps` | Yes | Defines a non-empty ordered list of task and plan blocks. |
| `piVisibility` | No | Adds the workflow to the model-facing roster and `workflow_start` tool. Defaults to `false`. |
| `legalTools` | No | Limits the Pi tools available throughout the workflow. |
| `contracts` | No | Maps contract ids to contained `contracts/*.schema.json` files. Discovery is automatic without it. |

A string step such as `steps/01-frame.md` is supported as legacy shorthand for
`run: steps/01-frame.md`. New workflows should use the explicit form.

### Task blocks

A task runs one Markdown instruction file to completion.

```yaml
- run: steps/01-inspect.md
  id: inspect
  tools: [read, grep]
  done: [implementation-checked, tests-checked]
  repair:
    max_attempts: 2
    strategy: [retry, block]
```

| Field | Required | Effect |
|---|---:|---|
| `run` | Yes | Names a contained Markdown instruction file. |
| `id` | No | Sets the block id. Otherwise the file stem is used, with a leading numeric prefix removed. |
| `tools` | No | Further limits the tools available for this task. |
| `done` | No | Lists criterion ids that a successful transition must report. |
| `repair` | No | Overrides the task recovery policy. |
| `inputs` | No | Binds earlier artifacts to this position; see [Artifacts and contracts](#artifacts-and-contracts). |
| `output` | No | Names the contract that `checkpoint.data` must satisfy. |
| `when` | No | Guards this task on an earlier artifact; see [Guards](#guards). |

Every block id must be unique within the workflow and match
`^[a-z][a-z0-9-]*$`.

### Plan blocks

A plan block asks the model to create a bounded plan from trusted operators.
The engine then runs each node in dependency order, one node per turn.

```yaml
- id: investigate
  plan:
    operators: [inspect, trace]
    repair:
      max_attempts: 2
      max_replans: 2
  inputs:
    brief:
      from: observe
      select: /data/scope
```

Plan blocks accept `inputs` (bound before plan creation), `repair`, and `when` guards. They
do not accept `output`; a completed plan emits an engine-generated aggregate
artifact (see below) rather than a contract-validated checkpoint.

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

A plan must contain 2 to 8 nodes. Node ids must be unique. Each node must use
an operator allowed by the block. Dependencies may name only earlier nodes or
retained results from a previous plan revision.

### Operators

Operators are trusted instruction files under `operators/`. The file stem is
the operator id. Plan creation sees only each operator's id and description.
Node execution also receives that operator's Markdown body.

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
`checkpoint.data` against that schema on every completion, blocked checkpoint,
and recovery checkpoint. A violation rejects the transition with the exact
schema-path errors, and restore drops a run whose persisted artifacts no
longer satisfy the current contracts.

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
  `{ "version": 1, "revision": n, "nodes": [{ "id", "operator", "objective", "result" }] }`.
  A pending node's `result` is `null`; a completed node's `result` is its full
  checkpoint. Retained results from earlier revisions appear after the current
  nodes.
- A position with declared inputs receives only those artifacts; the legacy
  prior-checkpoint summaries are suppressed.
- Binding edges are data dependencies: invalidating a producer removes its
  transitive consumers' checkpoints and resets downstream plans that consume
  the aggregate.

### Input budget

Rendered inputs share one budget of 24,576 bytes per position. The prompt
drops the largest entries first and names what was cut plus the surviving
top-level keys, so a `select` pointer can recover the missing data.
Contract-bearing node dependency data shares the same budget.

## Guards

A task or plan block may carry one `when` guard. The engine evaluates it
whenever the block becomes current: at start, after each transition, and
after recovery rewinds. A guard that does not hold skips the block with a
synthetic `skipped` checkpoint instead of running it.

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

Skipping rules:

- A skipped block records `{ summary, skipped: true }` and never prompts.
- A skipped plan block also drops its plan execution, so consumers never see a
  stale aggregate.
- Guards register a dependency edge like `inputs`, so invalidating a producer
  rewinds guard consumers and the guard re-evaluates on the next pass.

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

The applicable `repair` policy selects the next available action:

```yaml
repair:
  max_attempts: 2
  max_replans: 2
  strategy: [retry, invalidate, replan, block]
  scope: investigate
```

- **`retry`** runs the current position again while attempts remain.
- **`invalidate`** removes targeted results and their transitive dependents,
  then resumes at the earliest invalidated position.
- **`replan`** returns to plan creation while retaining valid completed
  results.
- **`block`** records the checkpoint and waits for user input.

Tasks default to `[retry, block]`. Plan blocks default to
`[retry, invalidate, replan, block]`. Both default to two runs per position.
Authors may set `max_attempts` from 1 to 3. Plans permit at most two replans and
two invalidations.

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

A completion must include every criterion from the task or plan node's `done`
list. Checkpoint summaries from earlier positions are shown to later
positions that declare no `inputs`; a position with declared `inputs`
receives those artifacts instead. `checkpoint.data` holds the authoring
interface's structured payload: when the position declares an `output`
contract, the engine validates `data` against it, and the position's prompt
shows the schema the model must satisfy. Positions without a contract may
write any JSON value.

`workflow_abort` stops the active run. choreograph saves a snapshot before
moving between positions and resumes active runs from the current session
branch. Snapshot format changes can make older active runs non-resumable; Pi
shows a warning and leaves the session idle in that case.

### Context isolation

Each position's kickoff is a one-line control message. During a run, the
LLM context starts at the latest control message for the active run: earlier
positions' tool output and conversation are dropped from the model's view.
Session history and the transcript UI stay complete; only what the model
sees is narrowed. Checkpoints carry the durable state between positions, so
a later position re-reads what it needs instead of inheriting the transcript.
If the control message is missing (for example after resuming into a session
branch that predates it), choreograph keeps the full context instead of
filtering.

### Tool access

choreograph starts with the tools that Pi made available at session start. It
then intersects that baseline with each configured ceiling:

1. The workflow's `legalTools` list.
2. The current task's `tools` list.
3. The current operator's `tools` list.

Active-run snapshots persist that baseline. Reloading a session restores the
run's full tool set instead of the narrowed active one.

`workflow_transition` and `workflow_abort` remain available during a run. An
unknown tool name has no effect and produces a warning at session start.

## Limits

choreograph enforces these main bounds:

| Data | Limit |
|---|---:|
| Workflow or instruction file | 128,000 bytes |
| Contract schema file | 64 KiB |
| Contracts per workflow | 16 |
| Inputs per position | 8 |
| Rendered input budget per position | 24 KiB |
| Dynamic plan | 32 KiB |
| Plan nodes | 8 |
| Checkpoint summary | 4 KiB |
| Complete checkpoint | 16 KiB |
| Plan node result | 8 KiB |
| Total workflow memory | 512 KiB |

Workflows are ordered sequences plus dynamic plans and guards. They do not support loops or free-form expressions over earlier task data; use a `when` guard for conditional steps instead.

## Development

Run the complete validation suite:

```bash
npm test
```

The command runs TypeScript in strict mode, then executes the engine,
authoring, persistence, runtime, and integration tests.

The project groups source by responsibility:

```text
src/
  authoring/   Workflow parsing and validation
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

This leaves the repository, workflows, and saved session data untouched. Start
a new Pi process afterward.

## License

[MIT](LICENSE) (c) 2026 choreograph contributors
