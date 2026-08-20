---
name: pi-workflows
description: Set up and maintain pi-workflows definitions for the pi coding agent. Use when creating or editing a workflow directory, writing WORKFLOW.md frontmatter, authoring step or operator markdown files, or diagnosing workflow discovery and validation errors.
---

# pi-workflows

pi-workflows is a pi coding-agent extension that runs stepped workflows from markdown definitions. A workflow resembles a skill, but its steps are explicit, ordered, and typed. The engine lives in this repository. Workflow definitions live outside it, under the agent data directory.

Use this skill to create, edit, and validate workflow definitions. Do not use it to modify the engine itself; engine internals are documented in the repository README.md.

## Where workflows live

- Default location: `~/.pi/agent/workflows/`
- Override with the `PI_CODING_AGENT_DIR` environment variable: definitions resolve under `$PI_CODING_AGENT_DIR/workflows`.
- One workflow per directory. The directory name is the workflow name and must match `^[a-z][a-z0-9-]*$`.
- The engine discovers workflows at session start. Directories without a `WORKFLOW.md` are ignored.
- All step and operator paths must stay inside the workflow directory. `..` and absolute paths are rejected.

## Workflow structure

```
my-workflow/
├── WORKFLOW.md          # Frontmatter + overview (required)
├── steps/
│   ├── 01-frame.md      # One markdown file per step
│   └── ...
└── operators/           # Optional; only for workflows with a planner
    ├── inspect.md
    └── trace.md
```

## Procedure: create a workflow

1. Create a directory under `~/.pi/agent/workflows/` named with the workflow name.
2. Create a `steps/` subdirectory with one numbered markdown file per step.
3. Write `WORKFLOW.md` with the frontmatter schema below plus a short overview body.
4. Add an `operators/` subdirectory only when the workflow uses a planner/executor pair.
5. Validate the definition with the check under "Validate a workflow" below.
6. Restart the pi session so discovery picks up the new directory.

## WORKFLOW.md frontmatter schema

```yaml
---
description: What it does and when to use it.
piVisibility: true              # Optional; exposes the workflow to the model
tools: [read, bash]             # Optional; workflow tool ceiling
model: anthropic/claude-haiku-4-5   # Optional; workflow default model
steps:
  - steps/01-frame.md           # String steps are legacy
  - path: steps/02-observe.md   # Mapping steps are structured
    id: observe
  - path: steps/03-plan.md
    kind: planner
  - path: steps/04-execute.md
    kind: executor
  - path: steps/05-verify.md
    done: [verdict-recorded]
    on:
      pass: converge
      rework: execute
      replan: plan
  - path: steps/06-deliver.md
---
```

Unknown keys are rejected. Required keys: `description` and `steps`.

| Key | Required | Effect |
|---|---|---|
| `description` | Yes | Appears in the workflow roster. |
| `steps` | Yes | Ordered list of markdown files inside the workflow directory. Each file must stay below 128,000 bytes. |
| `piVisibility` | No | Set `true` to expose the workflow to the model through the roster and the `workflow_start` tool enum. Defaults to `false`. |
| `tools` | No | When set, only these baseline tools stay active during a run. An empty list removes all baseline tools. `legalTools` is accepted as a legacy alias; providing both is invalid. |
| `model` | No | Workflow default model selector in `provider/model-id` form. Applies while steps run. |

A workflow with at least one mapping step is a structured workflow. An all-string workflow is a legacy workflow. Prefer structured workflows for new definitions.

## Structured step schema

| Key | Required | Effect |
|---|---|---|
| `path` | Yes | Markdown file relative to the workflow directory. |
| `id` | No | Stable routing ID matching `^[a-z][a-z0-9-]*$`. Defaults to the derived file label. |
| `kind` | No | `planner` or `executor`. Omit for a static step. |
| `tools` | No | Step tool ceiling, intersected with the workflow ceiling and the baseline. |
| `model` | No | `provider/model-id` override for this step. |
| `done` | No | Criterion IDs that a passing transition must list in `met`. |
| `on` | No | Non-default routes: `pass`, `rework`, or `replan`, each naming an existing step ID. |

Rules:

- Derive step labels from file stems: `01-surface.md` yields `surface`. Labels must be unique. Set an explicit `id` when stems collide or contain other characters.
- Declare exactly one `planner` and one later `executor` when either is present. A planner requires at least one operator file.
- Route defaults: `pass` goes to the next step (or completion after the last), `rework` returns to the current step, `replan` returns to the planner. Declare `on` only for non-default routes.
- Write each step file as the complete authority for its position. State the step's goal, rules, and expected checkpoint contents. Earlier steps are not repeated in later prompts.

## Operator schema

Operators are trusted instruction files under `operators/`. The file stem is the operator ID. The planner sees only IDs and descriptions; node prompts see only the operator body. Operator files are read when used, so edits take effect at the next invocation.

```yaml
---
description: Trace control and data flow through one relevant path.
tools: [read, bash]    # Optional; operator tool ceiling
---
# Trace

...operator instructions...
```

Unknown frontmatter keys are rejected. Keep operators generic and reusable across nodes. Model-generated plans reference operators by ID only; they cannot inject instructions.

## Model selection

- Use full `provider/model-id` selectors. Bare IDs and malformed shapes are rejected at parse time.
- Set `model` at workflow scope for the default, and at step scope to override.
- The session model is captured before a run and restored at completion or abort. Unresolvable selectors warn and continue; they never block a run.
- Model selection requires a structured manifest. Legacy workflows ignore model selectors.

## Validate a workflow

Run from the pi-workflows repository root:

```sh
node -e "import('./manifest.ts').then(({ discoverWorkflows }) => {
  const { workflows, diagnostics } = discoverWorkflows(require('node:os').homedir() + '/.pi/agent/workflows');
  console.log('workflows:', workflows.length);
  for (const d of diagnostics) console.log(d.path, d.error);
})"
```

A valid definition reports zero diagnostics. Fix every diagnostic before committing.

Also run the engine's suite when you change anything in this repository: `npm test`.

## Common failures and fixes

| Failure | Fix |
|---|---|
| Workflow missing from the roster. | Add or fix `WORKFLOW.md`, check the directory name pattern, restart the session. |
| `unknown key` error. | Remove the unsupported key from frontmatter. |
| Duplicate step label. | Set an explicit unique `id` on the colliding step. |
| Planner without operators. | Add at least one file under `operators/` or drop the `planner` kind. |
| Invalid `on` route. | Route only to existing step IDs: `pass`, `rework`, and `replan` targets must name a declared `id` or default label. |
| Planner/executor pairing error. | Declare exactly one `planner` and one `executor` that comes after it, or remove both kinds. |
| Path rejected. | Keep paths inside the workflow directory and relative to it. Remove `..` segments and absolute paths. |
| Step file too large. | Split the step or trim the file below 128,000 bytes. |
