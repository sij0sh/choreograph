---
name: choreograph
description: Set up and maintain choreograph definitions for the pi coding agent. Use when creating or editing a workflow directory, writing WORKFLOW.md frontmatter, authoring step, operator, loop, branch, or plan markdown files, or diagnosing workflow discovery and validation errors.
---

# choreograph

choreograph is a pi coding-agent extension that runs hierarchical workflows from markdown definitions. A workflow resembles a skill, but its structure is explicit, ordered, and typed. The engine lives in this repository. Workflow definitions live outside it, under the agent data directory.

Use this skill to create, edit, and validate workflow definitions. Do not use it to modify the engine itself; engine internals are documented in the repository README.md.

## Where workflows live

- Default location: `~/.pi/agent/workflows/`
- Override with the `PI_CODING_AGENT_DIR` environment variable; definitions resolve under `$PI_CODING_AGENT_DIR/workflows`.
- One workflow per directory. The directory name is the workflow name and must match `^[a-z][a-z0-9-]*$`.
- The engine discovers workflows at session start. Directories without a `WORKFLOW.md` are ignored.
- All instruction paths must stay inside the workflow directory. `..` and absolute paths are rejected.

## Workflow structure

```
my-workflow/
├── WORKFLOW.md          # Frontmatter + overview (required)
├── steps/
│   ├── 01-frame.md      # One markdown task file
│   └── ...
└── operators/           # Optional; trusted operator registry
    ├── inspect.md
    └── trace.md
```

## Procedure: create a workflow

1. Create a directory under `~/.pi/agent/workflows/` named with the workflow name.
2. Create a `steps/` subdirectory with one markdown file per task.
3. Write `WORKFLOW.md` with the frontmatter schema below plus a short overview body.
4. Add an `operators/` subdirectory when any `plan:` block will reference operators.
5. Validate the definition with the check under "Validate a workflow" below.
6. Restart the pi session so discovery picks up the new directory.

## WORKFLOW.md frontmatter schema

```yaml
---
description: What it does and when to use it.
piVisibility: true              # Optional; exposes the workflow to the model
tools: [read, bash]             # Optional; workflow tool ceiling
steps:
  - steps/01-frame.md           # String steps are legacy shorthand
  - run: steps/02-observe.md    # Task
    id: observe
    done: [evidence-recorded]
  - id: investigate             # Model-planned, engine-run
    plan:
      operators: [inspect, trace]
      repair:
        max_attempts: 2
        max_replans: 2
  - run: steps/06-deliver.md
    id: deliver
    repair:
      strategy: [invalidate, block]
      scope: investigate
---
```

### Rules

- Every block needs one unique id across the whole workflow. Tasks may derive ids from file stems.
- Use exactly one of `run` or `plan` per step entry. Loop, branch, predicate, and data-reference authoring were removed in v0.2; they fail as unknown keys.
- `plan` blocks need operator files for every listed operator id.
- `repair.strategy` may list any of `retry`, `invalidate`, `replan`, `block` in order.
- The old `kind: planner/executor` and `on:` route keys are rejected with migration errors. Use `plan:` blocks and `repair:` policy.

### Operators

Operators are trusted instruction files under `operators/`. The file stem is the operator id.

```yaml
---
description: Trace control and data flow through the relevant path.
tools: [read, bash]    # Optional; operator tool ceiling
---
# Trace
...operator instructions...
```

Planners see only ids and descriptions. Node execution sees only the current operator's body.

## Validate a workflow

Run from this repository after editing definitions:

```sh
node -e "import('./src/authoring/parser.ts').then(async (m) => { const r = await m.discoverWorkflows(process.env.HOME + '/.pi/agent/workflows'); console.log(r.diagnostics.length ? r.diagnostics : 'all workflows valid'); })"
```

Fix every reported diagnostic before restarting the session.

## Diagnosing discovery

- A workflow missing from the roster usually has invalid frontmatter; check the session-start warning for the parse error.
- Later positions read earlier outputs through the rendered prior checkpoints; no reference language exists.
- `delivery-pending` transition rejections mean the position's instructions have not arrived yet; finish the current reply first.
