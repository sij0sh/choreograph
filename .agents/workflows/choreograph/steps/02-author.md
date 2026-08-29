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
- Each step entry MUST use exactly one of `run`, `plan`, `script`, `for_each`, or `repeat_until`; a process-operator step uses `operator` instead.
- Omit `legalTools` so every position keeps the session's full toolset. Add `tools` on a task or operator only when that phase needs a narrower ceiling.
- A `plan:` block MUST list only operator ids that have files.
- `inputs.from` MUST name a block declared earlier in `steps` order.
- `output` MUST name a discovered contract id. It is invalid on `plan:` steps; plans emit an engine-generated aggregate.

## Guards

A task or plan step MAY carry one `when:` guard. The engine evaluates it
before the step runs; a guard that does not hold skips the step with a
synthetic `skipped` checkpoint.

```yaml
- run: steps/03-deep-trace.md
  id: deep-trace
  when:
    from: triage          # earlier step id
    select: /data/severity # optional JSON Pointer into the artifact
    op: in                 # equals | not-equals | in | not-in | exists | not-exists | gt | gte | lt | lte
    value: [high, critical]
```

Rules:
- `from` MUST name a block declared earlier in `steps` order.
- Value ops require `value`; `exists` and `not-exists` forbid it.
- `equals`/`not-equals` take a scalar; `in`/`not-in` take a non-empty scalar
  list; `gt`/`gte`/`lt`/`lte` take a finite number.
- A missing artifact or unresolvable pointer makes every value op false
  (including negations). Use `exists`/`not-exists` to key off presence.
- A guard registers a dependency edge, so invalidating the producer
  re-evaluates the guard on the next pass.

## Script steps

A script step runs one bounded local process with no model turn. The engine
spawns it, records its exit, and moves on; `workflow_transition` is rejected
at script positions.

```yaml
- id: run-tests
  script:
    argv: [npm, test]
    stdout: json
    timeoutMs: 120000
  output: test-report
```

Rules:
- `argv` is required; there is no shell. `cwd` stays inside the package
  (default `.`).
- `stdout`/`stderr` take `json`, `text`, or `none`; `json` stdout becomes the
  checkpoint data. `timeoutMs` defaults to 60000; `acceptedExitCodes` defaults
  to `[0]`.
- Declared `inputs` arrive as one JSON object on stdin.
- Script steps accept `id`, `script`, `repair`, `when`, `inputs`, and
  `output`. They reject `run`, `tools`, `done`, and `plan`.

## Loops

A loop repeats its body under a hard cap. `for_each` consumes a bound list;
`repeat_until` re-runs until a `when` guard holds.

```yaml
- id: review-files
  for_each:
    items: { from: gather, select: /data/files }
    body:
      steps:
        - run: steps/review-one.md
          id: read-one
          inputs: { item: { from: "$item" } }
        - id: check-one
          script: { argv: [node, check-one.mjs], stdout: json }
          inputs: { report: { from: read-one } }
    maxItems: 8
- id: fix-until-green
  repeat_until:
    body: { run: steps/apply-fix.md }
    when: { from: apply-fix, select: /data/exitCode, op: equals, value: 0 }
    maxIterations: 3
```

Rules:
- The cap (`maxItems`/`maxIterations`) is a required integer from 1 to 8.
- A body holds one `run` step, or a `steps:` list of 1 to 8 task, script, or
  process-operator entries. Loops and plans are not accepted inside a body.
- Body steps may bind `$item` (for_each only) or any earlier body step.
- `repeat_until` is do-while: the guard is evaluated after each iteration; cap
  exhaustion finishes the loop with `exhausted: true` in its aggregate.
- The loop writes one aggregate checkpoint: mode, iterations, the `exhausted`
  flag, and per-iteration outputs. Downstream steps bind `{ from: <loop-id> }`.

## Process operators

In any step list, including a loop body, an `operator:` entry invokes a
process operator (an operator whose frontmatter declares `script:`) as a
bounded local step:

```yaml
- id: fetch-status
  operator: deploy-status
  inputs: { brief: { from: observe } }
```

It accepts `inputs`, `repair`, and `when`, and inherits the operator's
`output` contract. Model operators cannot use this step form.

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
