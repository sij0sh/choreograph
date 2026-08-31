# Report

Purpose: close the run with a precise readiness report.

## Do

Use the declared `package` and `validation` inputs. Do not reconstruct details
from prior summaries.

Report:

1. The package name, package path, and slash command.
2. Every created or changed file from `package.files`.
3. The features selected in `package.featuresUsed`.
4. The package-local validation scope and validator invocation count.
5. The final ready or not-ready verdict.
6. Every remaining diagnostic when the package is not ready.
7. The next repair action when the package is not ready.
8. The restart requirement. Pi discovers workflows at session start, so a restart is required before the new or changed command is available.

State that validation covered package discovery and static design review. Do not
claim that it executed the authored workflow or its scripts.

## Done when

- `package-recorded`: The report names the package, command, path, files, and selected features.
- `validation-recorded`: The report states scope, invocation count, verdict, and any remaining diagnostics.
- `restart-recorded`: The report states the restart action.
