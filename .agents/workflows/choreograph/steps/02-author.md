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
|-- contracts/           # Optional contract schemas
|   |-- finding.schema.json
|   `-- verdict.schema.json
`-- operators/           # Only when a plan block references operators
```

## Frontmatter

Write `WORKFLOW.md` with this shape; unknown keys are rejected.

```yaml
---
description: What it does and when to use it.
piVisibility: false              # Optional; exposes the workflow to the model; defaults to false
legalTools: [read, bash]        # Optional; workflow tool ceiling
contracts:                       # Optional; maps contract ids to schema files
  finding: contracts/finding.schema.json
steps:
  - run: steps/02-observe.md    # A task
    id: observe
    output: brief               # Optional; declares the task's output contract
    done: [evidence-recorded]
  - id: investigate             # A dynamic plan
    inputs:                      # Optional; declared artifact bindings
      brief:
        from: observe
    plan:
      operators: [inspect, trace]
---
```

Rules:
- Every block id MUST be unique across the workflow.
- Each step entry MUST use exactly one of `run` or `plan`.
- A `plan:` block MUST list only operator ids that have files.
- `inputs.from` MUST name a block declared earlier in `steps` order.
- `output` MUST name a discovered contract id. It is invalid on `plan:` steps; plans emit an engine-generated aggregate.

## Contracts

Contracts are JSON Schema files under `contracts/`. The file stem becomes the
contract id. The engine validates each completed position's `checkpoint.data`
against its declared contract.

Write one schema file per named artifact from the frame step.

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

The accepted schema subset: `type` (with lists), `properties`, `required`,
`items`, `enum`, `const`, `additionalProperties` (boolean), `minItems`,
`maxItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`,
`oneOf` (up to 4), `title`, and `description`. Every other keyword fails
discovery. Schemas nest to at most 8 levels.

Every discovered contract compiles at discovery time, even when unused.

## Input bindings

Steps that consume earlier artifacts declare `inputs`. Each binding names a
producer step and an optional JSON Pointer `select`.

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

Rules:
- `select` is a JSON Pointer (RFC 6901) applied to the producer's artifact.
- Task producers expose their latest checkpoint.
- Plan producers expose the engine-generated aggregate
  `{ version, revision, nodes: [{ id, operator, objective, result }] }`;
  a pending node's `result` is `null`.
- Declared inputs replace prior checkpoint summaries, so bind every artifact
  the step needs.

## Operators

WHEN a step uses a `plan:` block, write `operators/<id>.md` for every listed id.

```yaml
---
description: Trace control and data flow through the relevant path.
tools: [read, bash]    # Optional; operator tool ceiling
output: finding         # Optional; declares the operator's output contract
---
# Trace
...operator instructions...
```

## Done when
- package-written: `WORKFLOW.md` and every referenced step file exist.
- paths-contained: every path is relative and stays inside the package.
- contracts-declared: one schema file exists per named artifact from the frame step, and every `output` names a discovered contract.
