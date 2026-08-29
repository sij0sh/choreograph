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
  - id: validate
    repeat_until:
      body:
        steps:
          - id: check
            script:
              argv: [node, scripts/validate-workflow-package.mjs]
              inheritEnv: [PATH, HOME, PI_CODING_AGENT_DIR]
              stdout: json
              timeoutMs: 120000
              acceptedExitCodes: [0]
          - run: steps/03-fix.md
            id: fix
            when: { from: check, select: /data/ok, op: not-equals, value: true }
            inputs:
              diagnostics: { from: check, select: /data/diagnostics }
            done:
              - diagnostics-addressed
      when: { from: check, select: /data/ok, op: equals, value: true }
      maxIterations: 3
  - run: steps/04-report.md
    id: report
    inputs:
      validation: { from: validate }
    done:
      - restart-recorded
      - validation-recorded
---

# Author a workflow

Frame the target, author the package, validate it with the engine parser until
the check passes or the loop caps out, and report.
