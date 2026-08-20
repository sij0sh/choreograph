# pi-workflows

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that runs stepped workflows from markdown definitions.

A workflow resembles a skill. It differs in one way. Its steps are explicit, ordered, and typed.

## Workflow definitions

Definitions are agent data. They live under `$PI_CODING_AGENT_DIR/workflows` (default `~/.pi/agent/workflows`). This repository hosts the engine only, so it stays location-independent.

### Structure

```
my-workflow/
├── WORKFLOW.md          # Frontmatter + overview
└── steps/
    ├── 01-first.md      # Markdown step
    └── 02-second.md
```

### Frontmatter

The workflow name equals its directory name and must match `^[a-z][a-z0-9-]*$`. The display title derives from the name. Directories without `WORKFLOW.md` are ignored.

```yaml
---
description: What it audits and when to use it.
steps:
  - steps/01-first.md
  - steps/02-second.md
piVisibility: true          # Optional; exposes the workflow to the model
legalTools: [bash, read]    # Optional; gates baseline tools during a run
---
```

| Field | Required | Effect |
|---|---|---|
| `description` | Yes | Appears in the roster. |
| `steps` | Yes | Ordered Markdown (`.md`) files inside the workflow directory. Each file must stay below 128,000 bytes. |
| `piVisibility` | No | Set `true` to expose the workflow to the model through the roster and the `workflow_start` enum. Defaults to `false`: the workflow stays user-invoked through its slash command. |
| `legalTools` | No | When set, only these baseline tools stay active during a run. Unknown entries produce a session-start warning. |

### Step labels

A label comes from the file stem. `01-surface.md` yields `surface`. A stem without a leading numeric prefix uses the whole stem: `phase-01-review.md` yields `phase-01-review`.

## Runtime behavior

1. `workflow_start <name>` (tool or slash command) starts a run at step 1.
2. Each step's kickoff is submitted to Pi's native follow-up queue. The message carries the current step instructions. A fresh run also carries the workflow overview.
3. `workflow_advance` moves to the next step or completes the run. Its result ends the turn; the next step's message follows.
4. `workflow_abort` stops the run and restores idle tools.

Rules:

- Only one run is active per session.
- A run survives a session close and resume. Every transition appends a snapshot to the session, and `session_start` restores the latest snapshot from the active branch.
- WHEN the workflow no longer exists or its step count shrank below the run's step, resume drops the run with a warning.
- Workflows are hidden from the model by default; `piVisibility: true` opts in. `workflow_start` lists only visible workflows. WHEN every workflow is hidden, the tool is not registered.
- Hidden workflows are startable only from their slash command.
- `workflow_advance` and `workflow_abort` are active only during a run.
- WHEN a workflow sets `legalTools`, the engine removes all other baseline tools for the run.
- Step transitions use Pi's native follow-up queue. A rejected delivery stays pending and retries at `agent_settled`.
- An undelivered step cannot advance.
- Snapshots persist the current step and its delivery status. Messages and system prompts read the workflow files when they are needed.
- A completed run submits one best-effort summary request. Completion summaries do not persist or replay after resume.

## Tests

`npm test` first type-checks `index.ts`, `manifest.ts`, and `types.ts` with `tsc --strict` via `tsconfig.json`, then runs the behavioral suite. A type error fails the suite before any tests run.

```sh
npm install
npm test
```
