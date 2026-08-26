# choreograph

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that runs ordered workflows from markdown definitions.

A workflow resembles a skill with one difference: its structure is explicit, ordered, and typed. Workflows compose task and plan blocks, execute resumably one position at a time, and keep recovery policy-driven.

## Workflow definitions

Definitions are agent data. They live under `$PI_CODING_AGENT_DIR/workflows` (default `~/.pi/agent/workflows`). This repository hosts the engine only, so it stays location-independent.

### Structure

```
my-workflow/
├── WORKFLOW.md          # Frontmatter + overview
├── steps/               # Recommended; any contained .md path works
│   ├── 01-frame.md      # Markdown task instructions
│   └── ...
└── operators/           # Optional; trusted operator registry (enforced name)
    ├── inspect.md
    └── trace.md
```

Path rules: `steps/` is a convention, not a parser rule; task files may live anywhere inside the workflow directory. `operators/` is enforced and non-recursive; the compiler scans only direct `operators/*.md` children and validates every discovered operator, including unused ones. Frontmatter in task files is stripped at prompt time and otherwise ignored.

### Frontmatter

The workflow name equals its directory name and must match `^[a-z][a-z0-9-]*$`. Unknown keys are rejected.

```yaml
---
description: What it does and when to use it.
piVisibility: true              # Optional; exposes the workflow to the model
legalTools: [read, bash]         # Optional; workflow tool ceiling
steps:
  - steps/01-frame.md           # String steps are legacy shorthand for run:
  - run: steps/02-observe.md    # A task
    id: observe
    done: [evidence-recorded]
  - id: investigate             # A dynamic plan
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

| Field | Required | Effect |
|---|---|---|
| `description` | Yes | Appears in the roster. |
| `steps` | Yes | Non-empty list of blocks. String entries are legacy shorthand for task `run:` entries. |
| `piVisibility` | No | Exposes the workflow through the roster and the `workflow_start` enum. Defaults to `false`. |
| `legalTools` | No | Workflow tool ceiling. |

### Block kinds

| Kind | Keys | Effect |
|---|---|---|
| Task | `run`, `id?`, `tools?`, `done?`, `repair?` | Runs one markdown instruction file to completion. |
| `plan` | `operators`, `repair?` | The model composes a bounded plan from trusted operators; the engine runs it one node per turn. |

Every block needs a unique `id` across the workflow; task ids may derive from their file stem. Workflows are static sequences and plans: loop (`for_each`), iterate (`repeat`), branch (`choose`), predicate (`until`), and data-reference (`$task.field`, `$current`) authoring were removed in v0.1.1 and now fail as unknown keys.

Task outputs reach later positions through rendered prior checkpoint summaries; no reference language exists. Arbitrary `checkpoint.data` is persisted but reserved for engine use such as plan payloads.

### Recovery

Tasks report `needs-work` with `issues: [{ target, reason }]`. Recovery policy decides what happens; authors never wire graph edges:

```yaml
repair:
  max_attempts: 2     # runs of the position per occurrence
  max_replans: 2      # invalidate + replan budget
  strategy: [retry, invalidate, replan, block]
  scope: investigate  # the plan block that invalidate and replan target
```

- **retry** re-runs the current position while attempts remain.
- **invalidate** removes the targeted plan results or task checkpoints plus transitive dependents, then resumes at the earliest invalidated node. WHEN the target names a node of the plan the current position belongs to, that plan owns the issue even when its result is absent. Otherwise the search spans plans in scope.
- **replan** returns to plan creation, retaining valid completed results.
- **block** records the checkpoint and waits for the user.

Defaults: tasks use `retry, block`; plan blocks use the full ladder.

### Operators

Operators are trusted instruction files under `operators/`. The file stem is the operator id. Plan creation sees only ids and descriptions; node execution sees only that node's operator body.

```yaml
---
description: Trace control and data flow through the relevant path.
tools: [read, bash]    # Optional; operator tool ceiling
---
# Trace
...operator instructions...
```

### Dynamic plans

A plan creation pass carries `checkpoint.data.plan`:

```json
{ "version": 1, "nodes": [ { "id", "operator", "objective", "dependsOn"?, "evidence"?, "done" } ] }
```

Validation happens before anything commits: 2-8 nodes, unique ids, only the block's trusted operators, dependencies on earlier nodes or retained results, and size bounds. Nodes never carry their own tools; the operator ceiling governs.

Hard limits: 2 node attempts, 2 replans, 2 invalidations per plan, 8 nodes, 4 KiB summaries, 16 KiB checkpoints, 8 KiB results, 32 KiB plans, 512 KiB total memory.

## Runtime behavior

1. `workflow_start <name>` (tool or slash command) starts a run at the first position.
2. Each position's kickoff is a one-line control message delivered when the agent settles, so at most one continuation is queued and none survive completion. Full instructions render in `before_agent_start`, so history never accumulates workflow content.
3. Every position concludes with `workflow_transition`:

```json
{
  "status": "completed",
  "met": ["scope-clear"],
  "checkpoint": { "summary": "Scope established." }
}
```

WHEN the position has problems, it concludes with:

```json
{
  "status": "needs-work",
  "checkpoint": { "summary": "Evidence is incomplete." },
  "issues": [{ "target": "inspect-auth", "reason": "No direct test evidence." }]
}
```

`workflow_abort` stops the run. WHEN a second transition arrives before its instructions, the engine rejects it with `delivery-pending`; one transition is accepted per agent turn.

### Tool authority

Active tools are the intersection of the captured Pi baseline, the workflow ceiling, the current task's ceiling, and the current operator's ceiling, plus `workflow_transition` and `workflow_abort`.

### Snapshots and resume

Every transition appends a durable snapshot before the in-memory state moves, and the delivery marker commits only after the follow-up is accepted. Active snapshots are version 5 and carry the full frame stack, checkpoints, and plan executions; restore revalidates them semantically against the current workflow. Snapshots from earlier engine versions drop with one actionable warning. Terminal snapshots stay minimal.

## Architecture

```text
src/
  authoring/   YAML schema, compiler
  domain/      Block AST, execution frames, checkpoints, policy, limits
  engine/      Pure stack interpreter and policy-driven recovery
  planning/    Dynamic plan schema, validation, graph helpers
  persistence/ v5 snapshot codec, semantic restore, session store
  runtime/     Capabilities, prompts, status, delivery, coordinator
  pi/          Tool, command, and lifecycle registration
```

The interpreter knows nothing about Pi, the filesystem, models, or the UI. Invariants live in `test/engine/invariants.test.mjs`.

## Tests

```sh
npm install
npm test
```

`tsc --strict` type-checks `src/`, then `node --test` runs the suites: pure engine tests (no mocks), authoring compiler tests, persistence round-trips, runtime contract tests, and end-to-end extension tests.
