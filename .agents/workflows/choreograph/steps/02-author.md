# Author

Purpose: write the complete package.

## Location
- Default root: `~/.pi/agent/workflows/`
- Override: definitions resolve under `$PI_CODING_AGENT_DIR/workflows`.
- Every instruction path MUST be relative to the package directory. The parser rejects `..` and absolute paths.

## Scaffold

```text
<name>/
|-- WORKFLOW.md          # Frontmatter + overview (required)
|-- steps/
|   |-- 01-frame.md      # One markdown task file
|   `-- ...
`-- operators/           # Only when a plan block references operators
```

## Frontmatter

Write `WORKFLOW.md` with this shape; unknown keys are rejected.

```yaml
---
description: What it does and when to use it.
piVisibility: false              # Optional; exposes the workflow to the model; defaults to false
legalTools: [read, bash]        # Optional; workflow tool ceiling
steps:
  - run: steps/02-observe.md    # A task
    id: observe
    done: [evidence-recorded]
  - id: investigate             # A dynamic plan
    plan:
      operators: [inspect, trace]
---
```

Rules:
- Every block id MUST be unique across the workflow.
- Each step entry MUST use exactly one of `run` or `plan`.
- A `plan:` block MUST list only operator ids that have files.

## Operators

WHEN a step uses a `plan:` block, write `operators/<id>.md` for every listed id.

```yaml
---
description: Trace control and data flow through the relevant path.
tools: [read, bash]    # Optional; operator tool ceiling
---
# Trace
...operator instructions...
```

## Done when
- package-written: `WORKFLOW.md` and every referenced step file exist.
- paths-contained: every path is relative and stays inside the package.
