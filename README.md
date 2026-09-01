# choreograph

> Choreograph runs multi-step Pi workflows in fresh context windows, with
> explicit handoffs, checkpoints, and validation between steps.

> **Status:** Choreograph is an MVP. Workflow files, snapshots, and runtime
> behavior can change between releases.

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the modules behind cross-package
contracts.

---

## [!] What Problem It Solves

Agent skills progressively add guidance to the current conversation. That works
well for focused instructions. It becomes less reliable when a long process
must share one growing context with tool output, intermediate reasoning, and
past decisions. The agent can lose the sequence, skip a check, or drift from
the original goal.

Choreograph moves the process out of conversation memory and into an explicit
workflow. Every model step starts in a fresh child session. It receives only
the workflow overview, its instructions, selected earlier outputs, completion
criteria, and the transition contract. The engine owns order, progress,
retries, and resume state.

The result is not a larger prompt. It is a series of small, bounded prompts
connected by validated state.

## [*] How Workflows Stay on Track

A workflow combines a few building blocks. Each one removes a different kind
of ambiguity.

| Building block | Problem it solves | How it solves it |
|---|---|---|
| **Task** | The next model action is known. | Runs one focused Markdown instruction in a fresh child context. |
| **Plan** | The goal is known, but the necessary investigation is not. | Lets the model build a small dependency plan from an author-approved operator set. |
| **Operator** | Dynamic plans need reusable expertise without becoming open-ended. | Defines one trusted capability, its instructions, tool ceiling, and optional output contract. |
| **Script** | A deterministic command should not depend on model judgment. | Runs one bounded local process directly, with controlled input, output, environment, and timeout. |
| **Loop** | The same model task must run over several items. | Repeats one task with a fresh context per item and a hard item cap. |
| **Contract** | Prose handoffs are easy to omit, rename, or misunderstand. | Validates checkpoint data against JSON Schema before the workflow advances. |
| **Input binding** | Later steps should not inherit the whole transcript. | Selects only declared outputs, or parts of them, from earlier checkpoints. |
| **Guard** | A step applies only under a known condition. | Evaluates structured earlier output and either runs or explicitly skips the step. |

Use tasks for a sequence you can design in advance. Use a plan when the model
must choose the investigation path at runtime. Give that plan a small operator
registry instead of unrestricted instructions. Use scripts for deterministic
work and loops only for bounded repetition. Add contracts wherever later
steps depend on structured output.

## [*] Vocabulary

| Term | Meaning |
|---|---|
| **Workflow** | The thing you author: a `WORKFLOW.md` package under a discovery root. |
| **Definition** | The workflow's frozen compiled representation, fixed by a content digest. |
| **Run** | One execution of a workflow. |
| **Step** | A declared unit in the workflow tree: task, script, plan, loop, or sequence. |
| **Position** | The site the model currently occupies, addressed by one key. |
| **Invocation** | One actual attempt to execute a position. |
| **Checkpoint** | The durable result committed at a boundary. |

The full reference for these terms and the file formats is
[WORKFLOW_REFERENCE.md](WORKFLOW_REFERENCE.md#vocabulary).

## [*] Key Features

* **Fresh context for every model position:** Context does not accumulate
  across the workflow. A bounded handoff carries only what the next position
  needs.
* **Author-controlled execution:** Ordered blocks, trusted operators, tool
  ceilings, completion criteria, guards, and hard limits define the rails.
* **Validated state handoffs:** Contracts catch malformed or incomplete data
  before it can mislead a later step.
* **Explicit data flow:** Input bindings make dependencies visible and keep
  unrelated history out of the prompt.
* **Durable recovery:** Choreograph checkpoints before advancing. Failed work
  retries under a declared policy, then parks for inspection and can resume
  with `workflow_retry`.
* **User-first invocation:** Every workflow gets a slash command. Workflows
  stay out of model context by default. Enable `piVisibility` only when the
  model should discover and start one itself.
* **Live progress rail:** A compact view above the editor shows phase state,
  the current position, and completed step summaries without cluttering the
  transcript. See [Progress View](#-progress-view).
* **Bounded runtime behavior:** Plan size, loop length, process time, captured
  output, retries, snapshots, and retained artifacts all have hard limits.

## [>] Quickstart

### Prerequisites

* Node.js 22.19+
* [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) ~0.84.x
* No API keys or required environment variables

### 1. Install Choreograph

```bash
pi install git:github.com/sij0sh/choreograph
```

Pi clones the package and loads its extension from the package manifest.

### 2. Enable the workflow author

The repository includes a Choreograph workflow that frames, writes, validates,
and reports a new workflow package. Link it into the workflow directory:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT_DIR/workflows"
ln -s "$AGENT_DIR/git/github.com/sij0sh/choreograph/.agents/workflows/choreograph" \
  "$AGENT_DIR/workflows/choreograph"
```

The link keeps the authoring workflow in sync with package updates. If the
target already exists, keep it or remove it before creating the link.
Inside the Choreograph repository itself the authoring workflow loads
automatically from `.agents/workflows/choreograph`; the link is only needed
to author workflows from other projects.

### 3. Author a workflow

Start a new Pi process, then describe the outcome to `/choreograph`:

```text
/choreograph Create a workflow that reviews a change, verifies its tests, and reports only actionable findings.
```

The authoring workflow will:

1. Frame the outcome, steps, handoffs, contracts, and conditions.
2. Choose tasks, plans, scripts, or loops for each responsibility.
3. Write the package under the workflow directory.
4. Run the engine's workflow validation and address diagnostics.
5. Report the files, validation result, and restart requirement.

Restart Pi after authoring. The new workflow is then available as a slash
command named after its directory:

```text
/review-change path/to/change
```

## [=] Configuration

Workflow packages load from two roots:

* Global: `$PI_CODING_AGENT_DIR/workflows` (default `~/.pi/agent/workflows`).
* Local: `<project>/.agents/workflows`, relative to the directory Pi starts
  in.

A local package overrides a global package with the same name, which keeps a
repo's workflows self-contained inside the repository. A package uses this
layout:

```text
my-workflow/
├── WORKFLOW.md          # Workflow overview and block sequence
├── steps/               # Focused task instructions
├── contracts/           # Optional JSON Schema handoff contracts
└── operators/           # Optional capabilities available to plans
```

The directory name becomes the slash command. Use lowercase kebab-case, such
as `review-change`.

Prefer `/choreograph` when creating or changing a package. It applies the
engine rules and runs validation as part of the process. For manual authoring,
all frontmatter fields, block parameters, schema keywords, runtime rules, and
limits are documented in [WORKFLOW_REFERENCE.md](WORKFLOW_REFERENCE.md).

## [=] Progress View

While a workflow runs, Choreograph shows a compact rail above the editor
instead of a footer status line:

```text
choreograph  review-change  RUNNING
[x] frame  [x] author  [>] validate  [ ] report
now validate/check  agent  attempt 2  loop 1/3
```

The rail shows discrete phase state, the current position, and the active
attempt. It never shows a percentage. Completed step summaries appear in
`detailed` mode. When the run finishes or aborts, the rail disappears; the
final report stays in the transcript.

| Control | Effect |
|---|---|
| `CHOREOGRAPH_TUI=off\|compact\|detailed` | Initial view mode for the process; default `compact`. |
| `/workflow-tui` | Cycle `off` -> `compact` -> `detailed` -> `off`. |
| `/workflow-tui [off\|compact\|detailed]` | Select one mode explicitly. |
| `/workflow-inspect` | Open a bounded snapshot panel of the active run. |

The view mode is a UI preference for the current process only; it is never
persisted with the run.

## [+] Common Tasks

Run a workflow from a fresh Pi process:

```text
/review-change path/to/change
```

The optional text after the command becomes the workflow target and reaches
every position. Only one workflow can be active at a time.

Resume a parked run or stop an active run by asking the agent:

```text
retry the parked workflow
abort the workflow
```

Choreograph exposes `workflow_retry` and `workflow_abort` as Pi tools. The
agent calls them. There are no user-facing slash commands for these actions.

Update installed Pi packages, then start a new Pi process:

```bash
pi update --extensions
```

Try only the extension for one Pi process without installing it:

```bash
pi -e git:github.com/sij0sh/choreograph
```

Run the project validation suite:

```bash
npm test
```

Remove the installed package, then start a new Pi process:

```bash
pi remove git:github.com/sij0sh/choreograph
```

---

[MIT](LICENSE) (c) 2026 Josh Simon
