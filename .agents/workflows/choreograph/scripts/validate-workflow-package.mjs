#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import path from "node:path";

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

const root = workflowsRoot();
try {
  const engine = await engineRoot();
  const parser = await import(pathToFileURL(path.join(engine, "src", "authoring", "parser.ts")));
  const discovered = await parser.discoverWorkflows(root);
  const verdict = {
    ok: discovered.diagnostics.length === 0,
    diagnostics: discovered.diagnostics,
    workflows: discovered.workflows.map((workflow) => workflow.name).sort(),
    root,
    engine,
  };
  process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
