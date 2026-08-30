import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, relative } from "node:path";
import { canonicalJson, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import { workflowBlocks, type Block, type TaskBlock, type Workflow } from "../domain/workflow.ts";

type InstructionReader = (path: string) => string | undefined;

/**
 * True when the file exists on disk and grew past the bound; undefined when stat
 * failed (missing or a virtual path), leaving the decision to the reader.
 */
function statOverBound(path: string, bound: number): boolean | undefined {
  try {
    return statSync(path).size > bound;
  } catch {
    return undefined;
  }
}

/** A frozen workflow definition: a content digest plus the frozen prompt sources by their workflow-relative paths. */
export interface FrozenDefinition {
  readonly digest: string;
  readonly contents: Readonly<Record<string, string>>;
}

/**
 * Freeze a workflow's definition and its prompt sources into an immutable snapshot.
 * The digest covers the whole workflow (structure, contracts, input edges, relative
 * paths) plus the frozen file contents, so any edit to any input changes it while
 * relocating the workflow directory does not.
 * Unreadable required files fail the freeze.
 */
export function freezeDefinition(workflow: Workflow, read: InstructionReader, workflowDir?: string): FrozenDefinition {
  const dir = workflowDir ?? dirname(workflow.overviewPath);
  const rel = (path: string): string => relative(dir, path);
  const contents: Record<string, string> = {};
  const add = (path: string, label: string): void => {
    const key = rel(path);
    if (contents[key] !== undefined) return;
    // Stat-first bound (fx2): a file grown past the instruction bound after discovery
    // is rejected at O(1) with discovery's wording, naming the file and the bound,
    // instead of being read and hashed in full on every start/resume retry.
    if (statOverBound(path, LIMITS.instructionFileBytes) === true) {
      throw new Error(`${label} "${key}" exceeds ${LIMITS.instructionFileBytes} bytes`);
    }
    const content = read(path);
    if (content === undefined) throw new Error(`${label} "${key}" is not readable; compilation cannot freeze it`);
    contents[key] = content;
  };
  add(workflow.overviewPath, "workflow overview file");
  for (const operator of workflow.operators.values()) add(operator.path, `operator ${operator.id} file`);
  for (const block of workflowBlocks(workflow)) {
    if (block.kind === "task") add(block.instructionPath, `task ${block.id} instruction file`);
  }
  const convert = (block: Block): Block => {
    if (block.kind === "sequence") return { ...block, children: block.children.map(convert) };
    if (block.kind === "loop") return { ...block, body: convert(block.body) as TaskBlock };
    if (block.kind === "task") return { ...block, instructionPath: rel(block.instructionPath) };
    return { ...block };
  };
  const definition = {
    name: workflow.name,
    title: workflow.title,
    description: workflow.description,
    overview: rel(workflow.overviewPath),
    piVisibility: workflow.piVisibility,
    ...(workflow.tools ? { tools: [...workflow.tools] } : {}),
    root: convert(workflow.root),
    operators: Object.fromEntries([...workflow.operators].map(([id, operator]) => [id, { ...operator, path: rel(operator.path) }])),
    contracts: Object.fromEntries([...workflow.contracts].map(([id, contract]) => [id, { ...contract, path: rel(contract.path) }])),
    inputEdges: Object.fromEntries([...workflow.inputEdges].map(([consumer, producers]) => [consumer, [...producers]])),
  };
  const digest = createHash("sha256").update(canonicalJson({ definition, contents } as unknown as JsonValue)).digest("hex");
  return { digest, contents };
}
