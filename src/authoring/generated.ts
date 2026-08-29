import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { compileWorkflow } from "./compile.ts";
import { deriveTitle, loadWorkflowManifest } from "./parser.ts";
import { LIMITS, NAME_PATTERN } from "../domain/limits.ts";
import type { JsonValue } from "../domain/json.ts";
import type { TaskBlock, Workflow } from "../domain/workflow.ts";
import type { CompiledWorkflowV2 } from "../domain/compiled-workflow.ts";

/**
 * A serializable workflow definition produced at runtime. The MVP grammar is
 * tasks only: every step is an agent task with inline Markdown instructions.
 */
interface GeneratedStepSpec {
  readonly id: string;
  readonly instruction: string;
  readonly done?: readonly string[];
}

export interface WorkflowDefinitionSpec {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly steps: readonly GeneratedStepSpec[];
}

export interface GeneratedWorkflow {
  readonly workflow: Workflow;
  readonly compiled: CompiledWorkflowV2;
  /** Instruction content keyed by virtual path; consumed by the prompt reader. */
  readonly instructions: Readonly<Record<string, string>>;
}

const SPEC_KEYS = ["name", "title", "description", "steps"] as const;
const STEP_KEYS = ["id", "instruction", "done"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function idAt(value: unknown, label: string): string {
  const id = string(value, label);
  if (!NAME_PATTERN.test(id)) throw new Error(`${label} must match ^[a-z][a-z0-9-]*$`);
  return id;
}

/**
 * Validate an untrusted definition spec. Byte caps bound persistence and
 * render cost; unknown keys are rejected so typos fail loudly.
 */
export function parseDefinitionSpec(raw: unknown): WorkflowDefinitionSpec {
  const body = record(raw, "definition");
  for (const key of Object.keys(body)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) throw new Error(`unknown definition key: ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > LIMITS.generatedDefinitionBytes) {
    throw new Error(`definition exceeds ${LIMITS.generatedDefinitionBytes} bytes`);
  }
  const name = idAt(body.name, "definition.name");
  const description = string(body.description, "definition.description");
  if (!Array.isArray(body.steps) || body.steps.length === 0) throw new Error("definition.steps must be a non-empty list");
  if (body.steps.length > LIMITS.generatedSteps) throw new Error(`definition.steps must have at most ${LIMITS.generatedSteps} entries`);
  const seen = new Set<string>();
  const steps = body.steps.map((entry, index) => {
    const step = record(entry, `definition.steps[${index}]`);
    for (const key of Object.keys(step)) {
      if (!(STEP_KEYS as readonly string[]).includes(key)) throw new Error(`unknown definition.steps[${index}] key: ${key}`);
    }
    const id = idAt(step.id, `definition.steps[${index}].id`);
    if (seen.has(id)) throw new Error(`definition.steps[${index}].id "${id}" is already used`);
    seen.add(id);
    const instruction = string(step.instruction, `definition.steps[${index}].instruction`);
    if (Buffer.byteLength(instruction, "utf8") > LIMITS.instructionFileBytes) {
      throw new Error(`definition.steps[${index}].instruction exceeds ${LIMITS.instructionFileBytes} bytes`);
    }
    let done: readonly string[] | undefined;
    if (step.done !== undefined) {
      if (!Array.isArray(step.done) || step.done.length === 0) throw new Error(`definition.steps[${index}].done must be a non-empty list`);
      if (step.done.length > LIMITS.checkpointListItems) throw new Error(`definition.steps[${index}].done must have at most ${LIMITS.checkpointListItems} entries`);
      done = step.done.map((criterion, criterionIndex) => idAt(criterion, `definition.steps[${index}].done[${criterionIndex}]`));
    }
    return { id, instruction, ...(done ? { done } : {}) } satisfies GeneratedStepSpec;
  });
  return {
    name,
    ...(body.title !== undefined ? { title: string(body.title, "definition.title") } : {}),
    description,
    steps,
  };
}

function buildStepFiles(spec: WorkflowDefinitionSpec): { files: Readonly<Record<string, string>>; steps: readonly TaskBlock[] } {
  const files: Record<string, string> = {};
  const steps: TaskBlock[] = [];
  for (const step of spec.steps) {
    const path = `/choreograph-generated/${spec.name}/steps/${step.id}.md`;
    files[path] = step.instruction;
    steps.push({ kind: "task", id: step.id, instructionPath: path, ...(step.done ? { done: step.done } : {}) });
  }
  const title = spec.title ?? deriveTitle(spec.name);
  files[`/choreograph-generated/${spec.name}/WORKFLOW.md`] = `# ${title}\n\n${spec.description}\n`;
  return { files, steps };
}

/**
 * Compile a validated spec into an ephemeral workflow. Instructions live in
 * memory behind virtual paths; the compiled digest covers the same normalized
 * node shape the file-based authoring path uses.
 */
export function buildGeneratedWorkflow(spec: WorkflowDefinitionSpec): GeneratedWorkflow {
  const { files, steps } = buildStepFiles(spec);
  const workflow: Workflow = {
    name: spec.name,
    title: spec.title ?? deriveTitle(spec.name),
    description: spec.description,
    overviewPath: `/choreograph-generated/${spec.name}/WORKFLOW.md`,
    piVisibility: false,
    root: { kind: "sequence", id: "root", children: steps },
    operators: new Map(),
    contracts: new Map(),
    inputEdges: new Map(),
  };
  const compiled = compileWorkflow(workflow, (path) => files[path]);
  return { workflow, compiled, instructions: files };
}

export const DEFINITIONS_ENTRY_TYPE = "choreograph-definitions";

function frontmatter(spec: WorkflowDefinitionSpec): string {
  const lines = [
    "---",
    stringify({ description: spec.description }, { lineWidth: 0 }).trimEnd(),
    "steps:",
  ];
  for (const step of spec.steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    run: steps/${step.id}.md`);
    if (step.done) {
      lines.push(`    done:`);
      for (const criterion of step.done) lines.push(`      - ${criterion}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Materialize a spec as a workflow directory under workflowsRoot and validate
 * it with the standard discovery path. The directory is removed when the
 * round trip fails so promotion never leaves an unparsable artifact behind.
 */
export function writePromotedWorkflow(spec: WorkflowDefinitionSpec, workflowsRoot: string): string {
  const directory = join(workflowsRoot, spec.name);
  if (existsSync(directory)) throw new Error(`workflow directory "${spec.name}" already exists`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(join(directory, "WORKFLOW.md"), `${frontmatter(spec)}\n`, "utf8");
    const stepsDirectory = join(directory, "steps");
    mkdirSync(stepsDirectory);
    for (const step of spec.steps) {
      writeFileSync(join(stepsDirectory, `${step.id}.md`), `${step.instruction.trimEnd()}\n`, "utf8");
    }
    const parsed = loadWorkflowManifest(directory);
    if (parsed.root.children.length !== spec.steps.length) throw new Error("round trip produced a different step count");
    for (const [index, child] of parsed.root.children.entries()) {
      if (child.id !== spec.steps[index].id) throw new Error(`round trip renamed step ${index} to ${child.id}`);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
