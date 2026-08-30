# Validate

Purpose: run the engine check and clear every diagnostic, or document what
remains.

## Do

1. Run the engine check with bash:

   ```bash
   node "$PI_CODING_AGENT_DIR/workflows/choreograph/scripts/validate-workflow-package.mjs"
   ```

   When `PI_CODING_AGENT_DIR` is unset, use
   `node ~/.pi/agent/workflows/choreograph/scripts/validate-workflow-package.mjs`.
   The script discovers every workflow package and prints a JSON verdict with
   `ok` and `diagnostics`.
2. WHEN the verdict has `ok: true`, record the outcome in the checkpoint and
   stop.
3. WHEN the verdict reports diagnostics, fix each one inside the package
   directory, then run the check again. Spend at most three runs in total.
4. Do not weaken the check. Never edit
   `scripts/validate-workflow-package.mjs` to make the verdict pass.
5. WHEN a diagnostic names a file outside the package under authoring (a
   pre-existing workflow), report the conflict in the checkpoint and leave
   that file unchanged.
6. WHEN diagnostics remain after the final run, list them in the checkpoint
   and mark the package not ready.

## Done when

- engine-check-run: the checkpoint records the final verdict, either `ok` or
  the remaining diagnostics.
- diagnostics-addressed: every reported diagnostic is fixed, or the conflict
  or remainder is stated in the checkpoint with the file named.
