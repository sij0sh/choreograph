# Validate

Purpose: run package-local discovery validation, review runtime semantics, and
fix defects. This step does not execute the authored workflow or its scripts.

## Package discovery validation

Read `package.name` and `package.packagePath` from the declared input. Run:

```bash
node "$PI_CODING_AGENT_DIR/workflows/choreograph/scripts/validate-workflow-package.mjs" "<package.name>"
```

When `PI_CODING_AGENT_DIR` is unset, use:

```bash
node ~/.pi/agent/workflows/choreograph/scripts/validate-workflow-package.mjs "<package.name>"
```

The script validates only that package. It prints a JSON verdict. A nonzero exit
means the verdict has diagnostics or the validator could not run. Inspect the
JSON instead of relying only on the exit status.

When diagnostics exist, fix package files and rerun. Use at most three validator
invocations total. Never edit the validator to make a package pass. When a
validator configuration error names `CHOREOGRAPH_ENGINE_ROOT`, set that variable
to the installed Choreograph extension root and rerun.

## Static design review

Compare the files against the declared `specification`. Record each completed
check in `semanticChecks`.

1. Every block has one responsibility and uses the selected kind for the problem it solves.
2. Every required cross-context handoff has an explicit input binding and a narrow selector where practical.
3. Every machine-consumed output has a compatible contract, and recovery data can satisfy it.
4. Every deterministic applicability decision uses a guard on a guaranteed value or an existence operator.
5. Every plan is truly dynamic, has a small non-overlapping operator set, and documents valid node requirements.
6. Every script has literal argv, sufficient inherited environment, bounded captures, safe stdin handling, an intentional timeout, accepted exits, and idempotent side effects.
7. Every loop source is guaranteed to be an array no larger than its cap, and each iteration is independent.
8. Every retry policy can plausibly improve the result and does not promise unsupported model-position retry.
9. Tool ceilings are least privilege without removing required tools.
10. Visibility matches the intended invocation path.
11. No prose condition duplicates an engine guard, and no required state relies on summaries.
12. The package stays within input, plan, loop, schema, checkpoint, and process limits.

Fix semantic defects and rerun discovery validation after any package edit when
an invocation remains. If no invocation remains, record the defect as a
remaining diagnostic and mark the package not ready.

## Validation checkpoint data

Complete with:

```json
{
  "name": "workflow-name",
  "packagePath": "/absolute/path/to/workflow-name",
  "ready": true,
  "scope": "package-discovery-and-static-review",
  "invocationCount": 1,
  "diagnostics": [],
  "semanticChecks": ["handoffs-explicit", "scripts-bounded"]
}
```

Set `ready` to true only when the final package-local verdict is `ok` and the
static design review has no remaining defects. Put validator failures and
semantic defects in `diagnostics` as concise strings.

## Done when

- `discovery-check-run`: The checkpoint records the final package-local verdict and invocation count.
- `design-reviewed`: The checkpoint records the completed semantic checks.
- `diagnostics-addressed`: Every diagnostic is fixed or remains listed with the package marked not ready.
