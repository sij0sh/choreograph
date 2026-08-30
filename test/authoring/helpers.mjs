import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows, loadWorkflowManifest } from "../../src/authoring/parser.ts";
import { LIMITS } from "../../src/domain/limits.ts";

export const roots = [];

function workflowDir(name, frontmatter, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pwf-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "steps"), { recursive: true });
  for (const file of options.files ?? ["steps/frame.md", "steps/01-frame.md", "steps/02-deliver.md", "steps/discover.md"]) {
    mkdirSync(join(dir, file.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, file), `---\ndescription: file\n---\n# ${file}`);
  }
  for (const [id, body] of Object.entries(options.operators ?? {})) {
    mkdirSync(join(dir, "operators"), { recursive: true });
    writeFileSync(join(dir, "operators", `${id}.md`), body);
  }
  writeFileSync(join(dir, "WORKFLOW.md"), `---\n${frontmatter.trim()}\n---\n\n# Overview\n`);
  return dir;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

export { assert, discoverWorkflows, join, LIMITS, loadWorkflowManifest, mkdirSync, mkdtempSync, symlinkSync, tmpdir, workflowDir, writeFileSync };
