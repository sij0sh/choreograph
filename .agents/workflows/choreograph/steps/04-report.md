# Report

Purpose: close the run with the restart requirement.

## Do
1. State the validation outcome from the `validation` input (the validate
   checkpoint). It records the final engine-check verdict: `ok`, or the
   remaining diagnostics with the package marked not ready.
2. List the created files.
3. State the restart requirement: the engine discovers workflows at session
   start, so a restart picks up the new package.

## Done when
- restart-recorded: the report names the restart step.
- validation-recorded: the report states the final engine-check outcome,
  including any exhaustion.
