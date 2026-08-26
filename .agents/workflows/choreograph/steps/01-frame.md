# Frame

Purpose: fix the target, shape, and artifact handoffs before any file is
written.

## Do
1. Record the target. State the workflow's purpose in one sentence.
2. Choose a name. The name MUST match `^[a-z][a-z0-9-]*$`.
3. List the planned steps. Give each step exactly one responsibility.
4. WHEN a step needs model-planned work, use a `plan:` block with named operators. Otherwise use a `run:` task.
5. Design the handoffs. For each step that produces structured output, name its output contract and name every downstream consumer of that artifact. WHEN a step consumes an earlier artifact, name the producer.

## Done when
- target-named: the purpose sentence names a concrete outcome.
- steps-planned: the list assigns one responsibility per step.
- contracts-declared: every structured-output step names an output contract, and every named artifact names at least one downstream consumer.
