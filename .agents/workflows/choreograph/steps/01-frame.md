# Frame

Purpose: fix the target and shape before any file is written.

## Do
1. Record the target. State the workflow's purpose in one sentence.
2. Choose a name. The name MUST match `^[a-z][a-z0-9-]*$`.
3. List the planned steps. Give each step exactly one responsibility.
4. WHEN a step needs model-planned work, use a `plan:` block with named operators. Otherwise use a `run:` task.

## Done when
- target-named: the purpose sentence names a concrete outcome.
- steps-planned: the list assigns one responsibility per step.
