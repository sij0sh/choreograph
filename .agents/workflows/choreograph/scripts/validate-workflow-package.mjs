#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import path from "node:path";

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

async function engineRoot() {
  if (process.env.CHOREOGRAPH_ENGINE_ROOT) return process.env.CHOREOGRAPH_ENGINE_ROOT;
  const realScriptDir = await realpath(path.dirname(fileURLToPath(import.meta.url)));
  return path.resolve(realScriptDir, "..", "..", "..", "..");
}

function workflowsRoot() {
  if (process.env.CHOREOGRAPH_WORKFLOW_ROOT) return process.env.CHOREOGRAPH_WORKFLOW_ROOT;
  const base = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent");
  return path.join(base, "workflows");
}

const packageName = process.argv[2] ?? "";
const root = workflowsRoot();
let engine;
let diagnostics = [];

try {
  if (!NAME_PATTERN.test(packageName)) {
    throw new Error("usage: validate-workflow-package.mjs <workflow-name>");
  }
  engine = await engineRoot();
  const parser = await import(pathToFileURL(path.join(engine, "src", "authoring", "parser.ts")));
  parser.loadWorkflowManifest(path.join(root, packageName));
} catch (error) {
  diagnostics = [error instanceof Error ? error.message : String(error)];
}

const verdict = {
  ok: diagnostics.length === 0,
  package: packageName || null,
  diagnostics,
  root,
  engine: engine ?? null,
};
process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
if (!verdict.ok) process.exitCode = 1;
