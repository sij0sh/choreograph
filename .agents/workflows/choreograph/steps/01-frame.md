# Frame

Purpose: fix the target, shape, and artifact handoffs before any file is
written.

## Do
1. Record the target. State the workflow's purpose in one sentence.
2. Choose a name. The name MUST match `^[a-z][a-z0-9-]*$`.
3. List the planned steps. Give each step exactly one responsibility.
4. Choose a block kind per step. Use a `run:` task for model work with a
   Markdown instruction, a `plan:` block for model-planned work from named
   operators, a `script:` step for a deterministic local process that needs no
   model turn, and a `for_each` or `repeat_until` loop for bounded repetition
   of task or script steps.
5. Design the handoffs. For each step that produces structured output, name its output contract and name every downstream consumer of that artifact. WHEN a step consumes an earlier artifact, name the producer.
6. WHEN a step should run only under a condition on an earlier artifact, give it a `when:` guard naming the producer, an optional `select` JSON Pointer, a closed `op`, and a `value` where the op needs one. Guards make "not applicable" an engine-decided skip instead of a failed or fabricated completion.

## Done when
- target-named: the purpose sentence names a concrete outcome.
- steps-planned: the list assigns one responsibility per step.
- contracts-declared: every structured-output step names an output contract, and every named artifact names at least one downstream consumer.
- guards-justified: every `when:` guard names its producer artifact, and no guarded step also relies on prose conditions.
