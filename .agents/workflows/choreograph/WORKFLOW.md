---
description: Design, author, and validate a Choreograph workflow package from a concrete outcome.
piVisibility: false
contracts:
  workflow-spec: contracts/workflow-spec.schema.json
  authored-package: contracts/authored-package.schema.json
  validation-report: contracts/validation-report.schema.json
steps:
  - run: steps/01-frame.md
    id: frame
    output: workflow-spec
    done:
      - target-named
      - steps-planned
      - features-considered
      - handoffs-declared
  - run: steps/02-author.md
    id: author
    inputs:
      specification: { from: frame, select: /data }
    output: authored-package
    done:
      - package-written
      - paths-contained
      - design-implemented
  - run: steps/03-validate.md
    id: validate
    inputs:
      package: { from: author, select: /data }
      specification: { from: frame, select: /data }
    output: validation-report
    done:
      - discovery-check-run
      - design-reviewed
      - diagnostics-addressed
  - run: steps/04-report.md
    id: report
    inputs:
      package: { from: author, select: /data }
      validation: { from: validate, select: /data }
    done:
      - package-recorded
      - validation-recorded
      - restart-recorded
---

# Author a workflow

Turn the requested outcome into the smallest reliable workflow. Choose each
feature for the ambiguity or failure mode that it removes. Carry the design
through explicit artifacts, validate the package, review its runtime semantics,
and report whether it is ready. Use at most three validator invocations total.
