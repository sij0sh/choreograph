# Frame

Purpose: design the smallest workflow that makes the requested outcome reliable.
Do not write files in this step.

## Start from failure modes

1. State the outcome in one sentence.
2. Choose a name that matches `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
3. Split the outcome into blocks with one responsibility each.
4. Identify what could otherwise be forgotten, guessed, repeated, malformed, or run nondeterministically.
5. Select a feature only when it removes one of those problems.

## Consider every feature

Record one `featureDecisions` entry for every feature below. Set `use` to false
when the workflow does not have the corresponding problem. Do not add a feature
only to demonstrate it.

| Feature | Use it when | Avoid it when |
|---|---|---|
| `task` | The next model responsibility is known. | The work is deterministic or requires runtime decomposition. |
| `plan` | The goal is known but the investigation path is not. | The sequence can be authored now. |
| `operator` | A plan needs a small reusable capability with approved instructions. | No plan uses it or capabilities overlap. |
| `script` | A bounded command, transform, or check must be deterministic. | Judgment is required. |
| `loop` | One homogeneous task must run independently over a known list of at most eight items. | Items interact, need different instructions, or can exceed the cap. |
| `contract` | A downstream decision depends on structured fields or types. | Output is human-only and no later block consumes it. |
| `input-binding` | A later block needs an earlier artifact. | A summary is enough only for orientation, never for required data. |
| `guard` | Applicability is a deterministic condition on earlier structured output. | The condition needs model judgment. |
| `tool-ceiling` | Least privilege improves safety or focus. | The phase legitimately needs the full session tool set. |
| `recovery` | Another attempt can repair a model or process failure. | Retrying side effects is unsafe or cannot help. |
| `visibility` | The model should discover and start the workflow after a user request. | Direct slash-command use is sufficient. |

Fresh model contexts are always active. Therefore, every required handoff must
be an input binding. Prior summaries are not data flow.

## Design each selected feature

- For a task, define its evidence-based `done` criteria and required tools.
- For a plan, define a non-overlapping operator set and why runtime planning is necessary.
- For an operator, define one capability, its tool ceiling, and its output shape.
- For a script, define stdin inputs, literal argv, contained cwd, inherited environment, captures, timeout, accepted exits, output contract, and idempotency.
- For a loop, define the list producer, body input, and a cap from 1 to 8. The source list must not exceed the cap. An oversized list fails before the body starts.
- For every machine-consumed output, define a contract and each consumer.
- For every consumer, bind only the needed field with an RFC 6901 pointer when practical.
- For a guard, use a contracted earlier field. Use `exists` or `not-exists` when absence is valid.
- For recovery, choose 1 to 3 attempts. Use more than one only when a retry can improve the result. Make side-effecting scripts safe under at-least-once execution.

## Check the limits

Keep each position within eight inputs and the shared 24 KiB input budget. Keep
plans between two and eight nodes. Keep loops at eight items or fewer. Keep
captured process output and files bounded. Prefer selectors and file captures to
large inline handoffs.

## Checkpoint data

Complete with `checkpoint.data` in this exact shape:

```json
{
  "name": "workflow-name",
  "purpose": "One concrete outcome.",
  "blocks": [
    {
      "id": "block-id",
      "kind": "task",
      "responsibility": "One responsibility.",
      "design": "Instructions, criteria, tools, recovery, inputs, output, guard, or feature-specific details."
    }
  ],
  "handoffs": [
    {
      "producer": "producer-id",
      "consumer": "consumer-id",
      "artifact": "contract-id or engine aggregate",
      "select": "/data/field or an empty string for the whole artifact"
    }
  ],
  "featureDecisions": [
    { "feature": "task", "use": true, "rationale": "The next responsibility is known." }
  ]
}
```

Include exactly one decision for each of the eleven feature names in the table.

## Done when

- `target-named`: The purpose names a concrete outcome and the name is valid.
- `steps-planned`: Every block has one responsibility and justified kind.
- `features-considered`: All eleven features have an explicit use decision tied to a problem.
- `handoffs-declared`: Every required artifact has a producer, consumer, contract or aggregate, and selector.
