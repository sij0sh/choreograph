---
description: Create a new choreograph workflow definition end to end.
piVisibility: false
steps:
  - run: steps/01-frame.md
    id: frame
    done:
      - target-named
      - steps-planned
      - contracts-declared
      - guards-justified
  - run: steps/02-author.md
    id: author
    done:
      - package-written
      - paths-contained
      - contracts-declared
  - run: steps/03-validate.md
    id: validate
    done:
      - engine-check-run
      - diagnostics-addressed
  - run: steps/04-report.md
    id: report
    inputs:
      validation: { from: validate }
    done:
      - restart-recorded
      - validation-recorded
---

# Author a workflow

Frame the target, author the package, run the engine check and fix every
diagnostic (at most three rounds), and report.
