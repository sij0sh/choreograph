import test from "node:test";
import { assert, loadWorkflowManifest, workflowDir } from "./helpers.mjs";

test("operator script frontmatter is rejected", () => {
  const dir = workflowDir("scripted-op", `
description: Process operator run.
steps:
  - steps/frame.md
`, {
    operators: {
      fetch: `---
description: Fetch data.
script:
  argv: [node, fetch.mjs]
---
Body`,
    },
  });
  assert.throws(() => loadWorkflowManifest(dir), /unknown operators\/fetch\.md frontmatter key: script/);
});

test("operator: steps are rejected", () => {
  const dir = workflowDir("op-step", `
description: Operator step run.
steps:
  - id: one
    operator: fetch
`, {
    operators: {
      fetch: `---
description: Fetch data.
---
Body`,
    },
  });
  assert.throws(() => loadWorkflowManifest(dir), /unknown steps\[0\] key: operator/);
});
