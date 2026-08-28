import { createHash } from "node:crypto";
import { relative } from "node:path";
import { canonicalJson, type JsonValue } from "../domain/json.ts";
import type { CompiledWorkflow } from "../domain/compiled-workflow.ts";
import { compiledNodes } from "../domain/node.ts";
import type { Workflow } from "../domain/workflow.ts";

export type InstructionReader = (path: string) => string | undefined;

export function compileWorkflow(workflow: Workflow, read: InstructionReader, workflowDir?: string): CompiledWorkflow {
  const nodes = compiledNodes(workflow, workflowDir);
  const instructionDigests = new Map<string, string>();
  const entries: JsonValue[] = [];
  for (const [blockId, spec] of nodes) {
    if (spec.runner !== "agent") continue;
    const content = read(spec.instructionPath);
    let contentDigest: string | undefined;
    if (content !== undefined) {
      contentDigest = createHash("sha256").update(content).digest("hex");
      instructionDigests.set(blockId, contentDigest);
    }
    // Digest location-independent forms: instruction paths relative to the workflow directory,
    // plus each instruction file's content digest so content changes invalidate the definition.
    const relativePath = workflowDir === undefined ? spec.instructionPath : relative(workflowDir, spec.instructionPath);
    entries.push({ ...spec, instructionPath: relativePath, ...(contentDigest ? { instruction: contentDigest } : {}) } as unknown as JsonValue);
  }
  const digest = createHash("sha256").update(canonicalJson({ version: 1, nodes: entries })).digest("hex");
  return { workflow, nodes, instructionDigests, digest };
}
