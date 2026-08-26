---
description: Create a new choreograph workflow definition end to end.
piVisibility: false
legalTools:
  - read
  - bash
  - edit
  - write
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
      - diagnostics-clean
  - run: steps/04-report.md
    id: report
    done:
      - restart-recorded
---

# Author a workflow

Frame the target, author the package, validate it, and report.
