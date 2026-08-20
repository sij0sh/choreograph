# pi-workflows

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that runs stepped workflows from markdown definitions.

A workflow resembles a skill. It differs in one way. Its steps are explicit, ordered, and typed.

Structured workflows add a second layer: a developer-authored state machine plus a model-generated, bounded reasoning plan that the runtime executes one trusted operator at a time.

## Workflow definitions

Definitions are agent data. They live under `$PI_CODING_AGENT_DIR/workflows` (default `~/.pi/agent/workflows`). This repository hosts the engine only, so it stays location-independent.

### Structure

```
my-workflow/
├── WORKFLOW.md          # Frontmatter + overview
├── steps/
│   ├── 01-frame.md      # Markdown step
│   └── ...
└── operators/           # Optional; trusted operator registry
    ├── inspect.md
    └── trace.md
```

### Frontmatter

The workflow name equals its directory name and must match `^[a-z][a-z0-9-]*$`. The display title derives from the name. Directories without `WORKFLOW.md` are ignored. Unknown keys are rejected.

```yaml
---
description: What it does and when to use it.
piVisibility: true              # Optional; exposes the workflow to the model
tools: [read, bash]             # Optional; workflow tool ceiling
model: anthropic/claude-haiku-4-5   # Optional; workflow default model
steps:
  - steps/01-frame.md           # String steps are legacy
  - path: steps/02-observe.md   # Structured step
    id: observe
  - path: steps/03-plan.md
    kind: planner
    done: [plan-ready]
  - path: steps/04-execute.md
    kind: executor
  - path: steps/05-verify.md
    on:
      pass: converge
      rework: execute
      replan: plan
  - path: steps/06-deliver.md
    model: anthropic/claude-opus-4-5
---
```

| Field | Required | Effect |
|---|---|---|
| `description` | Yes | Appears in the roster. |
| `steps` | Yes | Ordered Markdown (`.md`) files inside the workflow directory. Each file must stay below 128,000 bytes. |
| `piVisibility` | No | Set `true` to expose the workflow to the model through the roster and the `workflow_start` enum. Defaults to `false`. |
| `tools` | No | When set, only these baseline tools stay active during a run. An empty list removes all baseline tools. `legalTools` stays accepted as a legacy alias; providing both is invalid. Unknown entries produce a session-start warning. |
| `model` | No | Workflow default `provider/model-id` selector applied while steps run. See [Model selection](#model-selection). |

A workflow with at least one structured (mapping) step is a **structured workflow**. An all-string workflow is a **legacy workflow**.

### Structured steps

| Field | Required | Effect |
|---|---|---|
| `path` | Yes | Contained Markdown file. |
| `id` | No | Stable routing ID matching `^[a-z][a-z0-9-]*$`. Defaults to the derived file label. |
| `kind` | No | `planner` or `executor`. Missing means a static step. Exactly one planner and one later executor are required when either is present, and a planner requires at least one operator file. |
| `tools` | No | Step tool ceiling, intersected with the workflow ceiling and the baseline. |
| `model` | No | `provider/model-id` override for this step. |
| `done` | No | Criterion IDs required for a passing transition. |
| `on` | No | Non-default `pass`, `rework`, or `replan` destinations naming existing step IDs. `pass` defaults to the next step (or completion after the last), `rework` defaults to the current step, `replan` defaults to the planner. |

Step labels derive from file stems (`01-surface.md` yields `surface`) and must be unique; set explicit IDs when stems collide or contain other characters.

### Operators

Operators are trusted instruction files under `operators/`. The file stem is the operator ID. Small frontmatter, unknown keys rejected:

```yaml
---
description: Trace control and data flow through the relevant path.
tools: [read, bash]    # Optional; operator tool ceiling
---
# Trace
...operator instructions...
```

The planner sees only IDs and descriptions. A node prompt sees only the current operator's body (frontmatter stripped). Operator files are read when used, so edits take effect at the next invocation.

## Runtime behavior

1. `workflow_start <name>` (tool or slash command) starts a run at step 1.
2. Each position's kickoff is a one-line control message queued through Pi's native follow-up queue (`Continue workflow \`RUN_ID\` at observe.`). Full instructions render in `before_agent_start`, so conversation history never accumulates repeated workflow content.
3. Structured runs conclude each position with `workflow_transition`; legacy runs use `workflow_advance`.
4. `workflow_abort` stops the run and restores idle tools.

### workflow_transition

```ts
{
  outcome: "pass" | "blocked" | "rework" | "replan",
  met: string[],        // criterion IDs claimed complete
  checkpoint: { summary, evidence?, decisions?, unknowns?, data? },
  nodes?: string[]      // verifier rework only: node IDs to invalidate
}
```

- A pass must list every configured criterion in `met`; unknown or duplicate IDs are rejected.
- A blocked transition commits the checkpoint and stays delivered at the same position.
- Rework follows the step's `on.rework` destination. A verifier (a step whose rework routes to the executor) may name completed node IDs in `nodes`; their transitive dependents are invalidated too, and the run returns to the earliest invalidated node.
- Replan returns to the planner, preserves completed results, and burns one of two replans.
- Invalid transitions return concrete errors without changing state.

### Dynamic plans

A planner pass must carry `checkpoint.data.plan`:

```ts
{ "version": 1, "nodes": [ { "id", "operator", "objective", "dependsOn"?, "evidence"?, "done", "tools"? } ] }
```

Plans are validated in full before anything is committed: 2-8 nodes, unique IDs, known operators, dependencies only on earlier nodes or retained completed results, baseline tools only, and a 32 KiB canonical-JSON bound. Unknown keys, prompt-like fields, and per-node model selectors are rejected.

The executor runs exactly one node per turn in declaration order. A node prompt contains only the node's objective, its operator's body, declared dependency summaries, open unknowns, and its criteria. A node pass persists a bounded result; a node rework increments the attempt (max 2); a node replan returns to the planner with results retained.

Hard limits: 2 node attempts, 2 replans, 8 nodes, 4 KiB summaries, 16 KiB checkpoints, 8 KiB results, 32 KiB plans, 128 KiB total memory, JSON depth 8.

### Tool authority

Active tools are the intersection of the captured Pi baseline, the workflow ceiling, the current step's ceiling, the current operator's ceiling, and the current node's requested tools, plus the active control tools. Structured runs expose `workflow_transition` + `workflow_abort`; legacy runs expose `workflow_advance` + `workflow_abort`; they never appear together.

### Snapshots and resume

Every transition appends a durable snapshot before the in-memory state moves, and the delivery marker commits only after the follow-up is accepted. Runs survive session close and resume; a pending delivery retries at `agent_settled`.

Active snapshots are version 3: `{ v: 3, position, memory, delivered, ... }` with a stable step or node position. Legacy v1/v2 snapshots still restore; their numeric step maps to the derived step ID and the run starts with empty memory. Invalid or stale snapshots drop with one actionable warning. Terminal snapshots stay small and unchanged.

### Model selection

Optional `model` selectors at workflow or step scope run different models at different steps while the session default stays untouched outside the run.

- Selectors use the full `provider/model-id` form; bare IDs and malformed shapes are rejected at parse time.
- The runtime resolves a selector with `ctx.modelRegistry.find(provider, modelId)` and applies it with `ctx.setModel(model)` immediately before queuing each delivery, so the next turn uses it.
- The pre-run session model is captured once as `restoreModel` and restored at completion or abort.
- Resume re-applies the current position's model and never restores the session model.
- Unresolvable selectors and failed `setModel` calls warn and continue; a missing model catalog entry never blocks a run.
- Model selection requires a structured manifest; legacy workflows and generated plans never change the model. A manual `/model` change during a run is overridden at the next delivery.

## Tests

`npm test` type-checks the sources with `tsc --strict` via `tsconfig.json`, then runs the behavioral suites: `index.test.mjs` (legacy and registration), `manifest.test.mjs` (parsing and operators), `structured.test.mjs` (transitions, plans, execution, resume), and `model.test.mjs` (model selection). A type error fails the suite before any tests run.

```sh
npm install
npm test
```
