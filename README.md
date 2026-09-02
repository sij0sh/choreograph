# choreograph

> **Context engineering for multi-step Pi workflows.**
>
> Choreograph keeps each model step focused in a fresh context window while
> carrying forward the decisions, evidence, and artifacts the next step actually
> needs.

> Choreograph is an MVP. Workflow files, snapshots, and runtime
> behavior can change between releases.

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the modules behind cross-package
contracts.

---

## Context is part of the program

Long-running agent work is a context engineering problem. Prompting alone does
not fix it.

An agent does not reason over your workflow in the abstract. It reasons over
whatever is currently visible in its context window: the original request,
instructions, tool output, intermediate results, previous decisions, abandoned
paths, corrections, and the conversation produced while getting there.

As a process grows, two pressures appear.

**Context load** grows when more information remains simultaneously visible.
Useful information must compete with history that may no longer matter to the
current decision.

**Cognitive load** grows when the agent must maintain or repeatedly reconstruct
different reasoning frames: objectives, artifacts, evidence standards, tools,
decision policies, or completion conditions.

A larger context window does not remove either problem. It only increases how
much can be retained.

For short tasks this is often harmless. For longer workflows it can make
execution progressively less predictable:

* earlier instructions compete with the current task.
* intermediate reasoning is mistaken for durable state.
* old assumptions survive after the work that produced them is finished.
* later phases pull attention away from the current completion criterion.
* important decisions become buried in transcript history.
* retries inherit the same contaminated context that contributed to the failure.
* an agent asked to plan, implement, validate, and report must continually
  determine which reasoning frame it should currently be using.

The failure is not necessarily that the model has "forgotten" something.

Often it has been given too much to remember at once.

## Choreograph's approach

Choreograph treats context as a resource and constructs it deliberately for
each stage of a workflow.

Instead of running an entire process inside one accumulating conversation,
Choreograph breaks it into **bounded context epochs**.

Each model-bearing position runs in a fresh working context. That context
holds the stable request and constraints, the state deliberately handed forward
from earlier work, the current position's instructions and inputs, and the
controls needed to complete that position.

The full transcript is not the workflow state.

The workflow engine is.

When a position completes, Choreograph records a checkpoint and prepares the
state required by whatever runs next. Large outputs can stay in the artifact
store and be retrieved exactly when needed instead of sitting permanently in
the prompt.

What you get is a sequence of small reasoning environments connected by
explicit, validated state. No single prompt grows more elaborate.

```text
original request
      |
      v
+-------------+
|   frame     |  focused context
+-------------+
      |
      | checkpoint / artifacts
      v
+-------------+
| investigate |  fresh focused context
+-------------+
      |
      | validated handoff
      v
+-------------+
|   verify    |  fresh focused context
+-------------+
      |
      v
+-------------+
|   report    |  fresh focused context
+-------------+
```

Each position gets enough continuity to do its job without inheriting the
whole history of how the workflow got there.

## Context engineering in Choreograph

### Fresh context epochs

Every model-bearing position starts in a bounded context epoch.

The next position does not need the complete transcript of the previous one.
It receives the durable request and constraints, relevant workflow state,
bounded handoff information, and its own instructions.

This creates a real context boundary rather than merely adding another heading
to an existing prompt.

### Genesis preserves the original frame

Clearing context would be dangerous if it also erased the user's original
request.

Choreograph therefore protects a Genesis handoff containing the run identity,
target, workflow constraints, acceptance criteria, and environment.

The original frame survives even as transient reasoning is discarded.

### Checkpoints turn reasoning into state

Conversation history is a poor database.

At each workflow boundary, Choreograph requires the current position to commit
a checkpoint describing what was completed, the evidence gathered, unresolved
issues, decisions, and structured output.

Later work consumes this committed state instead of depending on whatever
happened to still stand out in the transcript.

### Explicit inputs control what comes back

A later position can declare exactly which earlier artifacts it needs.

```yaml
inputs:
  brief:
    from: observe
    select: /data/scope
  findings:
    from: investigate
    select: /nodes/0/result
```

This makes context construction part of the workflow definition.

Dependencies are visible and bounded. A position does not need every earlier
result merely because those results exist.

### Artifacts keep large state available without keeping it active

Some information must remain recoverable but does not need to consume active
context continuously.

Choreograph stores large checkpoint data and handoff sources as durable,
content-addressed artifacts. A later position can retrieve the omitted detail
the moment it becomes necessary.

This separates availability from visibility.

Information can survive the workflow without occupying every prompt.

### Contracts protect the boundary

A bad handoff can be worse than no handoff.

Tasks and operators can publish structured output through JSON Schema
contracts. Choreograph validates that state before allowing the workflow to
advance.

Contracts turn "the previous agent probably mentioned it" into an explicit
interface between reasoning stages.

### Bounded execution sets hard limits

Plans, loops, retries, process execution, captured output, checkpoint size, and
position inputs all have hard limits.

Bounds prevent a supposedly focused workflow stage from silently expanding
until it recreates the same context-management problem the workflow was meant
to solve.

## Workflow building blocks

These building blocks control reasoning boundaries, data flow, and
determinism.

| Building block      | Context-engineering role                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| **Task**            | Gives one model position a focused instruction, completion condition, and optional input/output contract. |
| **Plan**            | Allows runtime investigation without turning the entire workflow into open-ended reasoning.               |
| **Operator**        | Bounds what a dynamic plan is allowed to ask a model or process to do.                                    |
| **Script**          | Runs deterministic work as plain code, outside the model.                                                 |
| **Loop**            | Repeats work under an explicit hard cap instead of creating an unbounded reasoning cycle.                 |
| **Contract**        | Defines the state interface crossing a workflow boundary.                                                 |
| **Input binding**   | Selects which earlier state is allowed back into the current context.                                     |
| **Guard**           | Keeps irrelevant branches from entering the reasoning path at all.                                        |
| **Checkpoint**      | Converts completed reasoning into durable workflow state.                                                 |
| **Recovery policy** | Repairs invalid state without blindly replaying the entire conversation.                                  |

The important design question is what the model should think about now and
what state must survive when that context ends. The number of steps is
a secondary question.

## Quickstart

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

The repository includes a Choreograph workflow for designing and validating
new workflows:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT_DIR/workflows"
ln -s "$AGENT_DIR/git/github.com/sij0sh/choreograph/.agents/workflows/choreograph" \
  "$AGENT_DIR/workflows/choreograph"
```

The link keeps the authoring workflow in sync with package updates. Inside the
Choreograph repository itself it loads automatically from
`.agents/workflows/choreograph`.

### 3. Author a workflow

Start a new Pi process and describe the outcome:

```text
/choreograph Create a workflow that reviews a change, verifies its tests, and reports only actionable findings.
```

The authoring workflow will:

1. identify the reasoning stages and their completion boundaries;
2. decide what state must cross each boundary;
3. choose tasks, plans, scripts, loops, contracts, and guards accordingly;
4. write the workflow package;
5. validate it against the engine.

Restart Pi after authoring. The resulting workflow is available through its
directory name:

```text
/review-change path/to/change
```

## Designing context boundaries

A workflow package has this shape:

```text
my-workflow/
├── WORKFLOW.md          # Stable frame and workflow structure
├── steps/               # Focused model instructions
├── contracts/           # Optional structured handoff interfaces
└── operators/           # Optional bounded capabilities for plans
```

Packages load from:

* Global: `$PI_CODING_AGENT_DIR/workflows`
  (default `~/.pi/agent/workflows`)
* Local: `<project>/.agents/workflows`

A local package overrides a global package with the same name.

When designing a workflow, prefer boundaries where the next stage requires a
meaningfully different objective, artifact, evidence standard, capability set,
or completion condition.

Do not create stages merely to make files smaller.

Each boundary creates a handoff, so it should earn that cost by reducing the
amount of irrelevant reasoning state the next position would otherwise have to
carry.

For manual authoring, [WORKFLOW_REFERENCE.md](WORKFLOW_REFERENCE.md) documents
every frontmatter field, block parameter, schema keyword, runtime rule, and
limit.

## Progress without transcript pollution

Choreograph shows workflow progress in a compact rail above the editor:

```text
choreograph  review-change  RUNNING
[x] frame  [x] author  [>] validate  [ ] report
now validate/check  agent  attempt 2  loop 1/3
```

Operational state does not need to become conversational state.

The progress view exposes where the workflow is without adding status chatter
to the model transcript.

| Control                                  | Effect                                           |
| ---------------------------------------- | ------------------------------------------------ |
| `CHOREOGRAPH_TUI=off\|compact\|detailed` | Initial process view; default `compact`.         |
| `/workflow-tui`                          | Cycle `off` -> `compact` -> `detailed` -> `off`. |
| `/workflow-tui [off\|compact\|detailed]` | Select a mode explicitly.                        |
| `/workflow-inspect`                      | Inspect a bounded snapshot of the active run.    |

The view preference is not persisted with the run.

## Recovery is state repair, not conversation replay

A workflow checkpoint is committed before Choreograph advances.

If later work discovers a problem, recovery can retry the current position,
invalidate affected state, replan bounded dynamic work, or park for user input.

Failure does not require restoring an entire historical conversation and hoping
the model interprets it correctly the second time. Choreograph returns to the
affected workflow state instead.

Ask the agent to:

```text
retry the parked workflow
abort the workflow
```

Only one workflow can be active at a time.

## Common tasks

Update installed Pi packages:

```bash
pi update --extensions
```

Try the extension for one Pi process without installing it:

```bash
pi -e git:github.com/sij0sh/choreograph
```

Run the validation suite:

```bash
npm test
```

Remove the package:

```bash
pi remove git:github.com/sij0sh/choreograph
```
