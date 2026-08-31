# choreograph

> choreograph runs multi-step Pi workflows in fresh context windows, with
> explicit handoffs, checkpoints, and validation between steps.

> **Status:** choreograph is an MVP. Workflow files, snapshots, and runtime
> behavior can change between releases.

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the modules behind cross-package
contracts.

---

## [!] What Problem It Solves

Pi skills use progressive disclosure: the agent loads more guidance into the
same conversation as the work unfolds. That works for focused instructions,
but long workflows must compete with an accumulating transcript, tool output,
and intermediate reasoning. As context fills, the agent can lose the sequence,
skip checks, or drift from the original task.

choreograph makes each workflow step a context boundary. Every model step
starts in a fresh child session with a bounded handoff: the workflow overview,
current instructions, declared inputs, checkpoint summaries, completion
criteria, and transition contract. The engine owns order, progress, retries,
and resume state instead of relying on conversation memory.

## [*] Key Features

* **Fresh context for every step:** Each model position starts in a new child
  session. A bounded handoff carries only the state that the next step needs.
* **Author-controlled rails:** Ordered blocks, completion criteria, strict
  transitions, guards, and tool ceilings define what may run and what counts
  as complete.
* **Validated handoffs:** JSON Schema contracts validate structured outputs.
  Explicit JSON Pointer bindings select which earlier artifacts reach each
  step.
* **Durable progress:** choreograph checkpoints before advancing. Failed work
  retries under a declared policy, then parks for inspection and resumes with
  `workflow_retry`.
* **User-first invocation:** Workflows are slash commands by default, so the
  workflow catalog does not consume model context. Set `piVisibility: true`
  only when the agent should discover and start a workflow itself.
* **Tasks, plans, scripts, and loops:** Use direct model instructions, bounded
  dependency plans, local processes without a model turn, or capped iteration.
* **A workflow for authoring workflows:** The included
  `.agents/workflows/choreograph` workflow frames, writes, validates, and
  reports a new workflow package using the same engine it targets.
* **Bounded runtime behavior:** Stall nudges, absolute script deadlines,
  snapshot caps, and artifact retention turn silent hangs and unbounded growth
  into explicit failures with recovery paths.

## [>] Quickstart

### Prerequisites

* Node.js 22.19+
* [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) ~0.84.x
* No API keys or environment variables are required.

### Installation & Run

Install from a clone of this repository:

```bash
# 1. Clone & enter the repository
git clone git@github.com:sij0sh/choreograph.git
cd choreograph

# 2. Install dependencies
npm install

# 3. Symlink the extension into Pi
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD" ~/.pi/agent/extensions/choreograph

# 4. Start Pi
pi
```

The symlink points at the checkout. Future pulls need no reinstall. Start a
new Pi process after installing or updating.

To try it without installing, run `pi -e ./src/index.ts` from the repository
root. This loads choreograph for that Pi process only.

## [=] Configuration

There are no environment variables. Configuration lives in workflow
directories under `$PI_CODING_AGENT_DIR/workflows` (default
`~/.pi/agent/workflows`). The directory name is the workflow id and slash
command. Use lowercase kebab-case (`review-change`, not `Review_Change`).

### Workflow frontmatter

`WORKFLOW.md` must start with YAML frontmatter. Unknown fields are rejected.
The Markdown body is the overview shown at every position.

```yaml
---
description: Inspect a code change and report actionable findings.
piVisibility: true
legalTools: [read, grep, bash]
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
```

| Field | Required | Effect |
|---|---:|---|
| `description` | Yes | Describes the workflow in Pi and to the model. |
| `steps` | Yes | A non-empty ordered list of task, plan, script, and loop blocks. |
| `piVisibility` | No | Adds the workflow to the model-facing roster and `workflow_start` tool. Default `false`. |
| `legalTools` | No | Limits Pi tools for the whole workflow. |
| `contracts` | No | Maps contract ids to `contracts/*.schema.json` files. Discovery is automatic without it. |

### Directory layout

```text
my-workflow/
├── WORKFLOW.md          # Required frontmatter and overview
├── steps/               # Convention only; any contained .md path works
├── contracts/           # Optional JSON Schema files
└── operators/           # Optional trusted operator registry
```

`operators/` and `contracts/` are enforced names. choreograph reads only
direct children and validates every discovered file, used or not. Paths cannot
escape the workflow directory through `..`, absolute paths, or symlinks.

### Task blocks

A task runs one Markdown instruction file to completion.

| Field | Required | Effect |
|---|---:|---|
| `run` | Yes | Names a contained Markdown instruction file. |
| `id` | No | Defaults to the file stem minus a leading numeric prefix. |
| `tools` | No | Narrows tools for this task. |
| `done` | No | Criterion ids a successful transition must report. |
| `repair` | No | `{ max_attempts: 1..3 }`, default 2. |
| `inputs` | No | Binds earlier artifacts. |
| `output` | No | Contract that `checkpoint.data` must satisfy. |
| `when` | No | Guard on an earlier artifact. |

Block ids are unique per workflow and use lowercase kebab-case.

### Plan blocks

A plan asks the model to build 2 to 8 nodes from trusted operators. The engine
runs each node in dependency order, one node per turn. Every node needs a
non-empty `done` list. Dependencies may name only earlier nodes.

```yaml
- id: investigate
  plan:
    operators: [inspect, trace]
    repair: { max_attempts: 2 }
```

Operators live under `operators/*.md`; the stem is the id. Operator
frontmatter accepts `description`, `tools`, and `output`. Plan blocks accept
`inputs`, `repair`, and `when`; they reject `output`. A completed plan emits
an engine-generated aggregate instead of a contract-validated checkpoint.

### Script steps

A script step runs one bounded local process. No model turn runs.

```yaml
- id: run-tests
  script:
    argv: [npm, test]        # Required; no shell, literal arguments
    cwd: .                   # Inside the workflow directory
    env: { CI: "1" }         # Overrides; inheritEnv allowlists the rest
    inheritEnv: [PATH, HOME]
    timeoutMs: 120000        # 1,000-600,000, default 60,000
    acceptedExitCodes: [0]
    stdout: json             # json | text | none
    stderr: text             # none | text | json
    maxCaptureBytes: 65536   # Shared stdout+stderr cap, 1 MiB max
    files:                   # Up to 4 { name, path } captures
      - { name: log, path: out/log.txt }
  output: test-report        # Optional contract id
```

* `timeoutMs` ends with SIGTERM, then SIGKILL after a 5 second grace, then a
  1 second drain. The deadline is absolute from spawn, so descendants that
  escape the process group cannot wedge settlement.
* Declared `inputs` arrive as one JSON object on stdin (24 KiB budget). No
  implicit interpolation into `argv` or `env`.
* `stdout: json` parses stdout into `checkpoint.data`. Script stdout keys win
  over runtime side keys (`stderr`, `files`) in the merged data.
* A timeout, rejected exit code, invalid JSON, contract violation, or spawn
  failure retries the step through `repair`; exhausted attempts park the run.

### Loop blocks

A loop runs one task body once per item under a hard cap.

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

`items` must resolve to a list, materialized once at loop start. `maxItems` is
1 to 8. The body is exactly one `run` step and may bind `$item`. Recovery is
per iteration; earlier iterations stay untouched. The loop finishes with one
aggregate checkpoint: `{ mode, iterations, results }`.

### Contracts and input bindings

Contracts are JSON Schema files under `contracts/`; the stem is the id. Tasks
and operators declare `output: <contract-id>`. The engine validates
`checkpoint.data` on completion, blocked, and recovery checkpoints.

Accepted keywords: `type` (single or list), `properties`, `required`, `items`,
`enum`, `const`, `additionalProperties` (boolean), `minItems`, `maxItems`,
`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `oneOf` (2-4
branches), `title`, `description`. Schemas nest at most 8 levels and stay
under 64 KiB.

Inputs resolve with RFC 6901 JSON Pointers:

```yaml
inputs:
  brief: { from: observe, select: /data/scope }
```

`from` names an earlier block. Rendered inputs share a 24 KiB budget per
position; the prompt drops the largest entries first and names what was cut.

### Guards

A task or plan block may carry one `when` guard, evaluated when the block
becomes current. A guard that does not hold skips the block with a synthetic
`skipped` checkpoint.

| Field | Required | Effect |
|---|---:|---|
| `from` | Yes | An earlier block in `steps` order. |
| `select` | No | JSON Pointer into the producer's artifact. |
| `op` | Yes | `equals`, `not-equals`, `in`, `not-in`, `exists`, `not-exists`, `gt`, `gte`, `lt`, `lte`. |
| `value` | Depends | Required by the eight value ops; forbidden for `exists`/`not-exists`. |

A missing operand or an unevaluable comparison fails the transition with an
error naming the block, the op, and the pointer. Guards never skip silently.

### Runtime rules

* Each position ends with one `workflow_transition` call. The schema is
  strict: extra properties, unknown statuses, and malformed checkpoints are
  rejected. Copy `key` verbatim from the position envelope. A transition
  applies only to the position it names; stale or replayed transitions change
  nothing.
* Incomplete work reports `needs-work` with diagnostic `issues[]`. The engine
  retries the current position up to `max_attempts`, then parks the run and
  waits for the user.
* Snapshots are format v7; earlier formats are not resumable. Restoring a run
  whose workflow was edited mid-flight is refused via a content digest.
* Tools start from the Pi session baseline, intersected with `legalTools`,
  task `tools`, and operator `tools`. `workflow_transition` and
  `workflow_abort` stay available during a run.

### Limits

| Data | Limit |
|---|---:|
| Workflow or instruction file | 128,000 bytes |
| Contract schema file / count | 64 KiB / 16 per workflow |
| Inputs per position / budget | 8 / 24 KiB |
| Prior checkpoint summaries | 8, 1 KiB each, 8 KiB total |
| Plan nodes / plan size | 8 / 32 KiB |
| Checkpoint summary / complete | 4 KiB / 16 KiB |
| Loop items (cap) | 8 |
| Recovery attempts | 1-3, default 2 |
| Settle-guard nudges | 3 |
| Script argv / env entries | 64 / 32 |
| Script timeout | 1,000-600,000 ms |
| Script capture | 64 KiB default, 1 MiB max |
| Snapshot entries / bytes per session | 256 / 16 MiB |
| Run artifact retention | 20 runs / 256 MiB, oldest first |
| Materialized copies | 64 MiB with 10 min grace |
| Total workflow memory | 512 KiB |

Workflows do not support nested loops, unbounded `while`, concurrency, or
free-form expressions. Use a `when` guard for conditional steps.

## [+] Common How-To Tasks

Run a workflow from a fresh Pi process:

```text
/review-change path/to/change
```

The text after the command is optional. It reaches every position as the
workflow target. Only one workflow can be active at a time.

Resume a parked run or stop an active run by asking the agent in the Pi
session:

```text
retry the parked workflow
abort the workflow
```

choreograph exposes `workflow_retry` and `workflow_abort` as Pi tools. The
agent calls them; there are no user-facing slash commands for them.

Run the validation suite (strict TypeScript, then engine, authoring,
planning, persistence, pi, runtime, and integration tests):

```bash
npm test
```

Uninstall by removing the symlink, then start a new Pi process:

```bash
unlink ~/.pi/agent/extensions/choreograph
```

## [?] Troubleshooting & Edge Cases

* **Issue:** `run stalled at <key>: 3 replies ended without a workflow_transition call`
* **Fix:** The model wrote the transition as text instead of calling the tool.
  Send the agent a message to unstick it, or call `workflow_abort`.

* **Issue:** The run parks at a position after `max_attempts` exhausted.
* **Fix:** Address the reported `issues[]`, then resume with `workflow_retry`.
  Retry is rejected while a script process is still in flight.

* **Issue:** `workflow_transition` fails validation.
* **Fix:** Copy `key` verbatim from the `Position` line. Pass only the
  schema-defined checkpoint fields; extra properties such as `data` under
  `checkpoint` are rejected.

* **Issue:** A saved run will not resume after a choreograph update or a
  workflow edit.
* **Fix:** Snapshots resume only in format v7, and a workflow edited mid-run
  fails the digest check. Abort or finish the run before editing; start a new
  run after an update.

* **Issue:** A script step fails with a contract or JSON error.
* **Fix:** Check `acceptedExitCodes`, keep stdout valid JSON when
  `stdout: json`, and keep the stdin payload under 24 KiB. Output past the
  capture cap is truncated and flagged in the checkpoint.

* **Issue:** `Unknown tool` warning at session start.
* **Fix:** A `legalTools` or `tools` name is not in Pi's baseline tool set.
  Remove the name or enable the tool in Pi.

---

[MIT](LICENSE) (c) 2026 choreograph contributors
