# Fix

Purpose: clear every diagnostic the engine check reported.

## Do
1. Read each diagnostic from the `diagnostics` input. It names a package file
   and the parser error.
2. Fix the package files. Keep every fix inside the package directory.
3. Do not weaken the check. Never edit `scripts/validate-workflow-package.mjs`
   to make the verdict pass.
4. WHEN a diagnostic names a file outside the authored package (a pre-existing
   workflow), report the conflict in the checkpoint and leave that file
   unchanged.

## Done when
- diagnostics-addressed: every reported diagnostic is fixed, or the conflict
  is stated in the checkpoint with the untouched file named.
