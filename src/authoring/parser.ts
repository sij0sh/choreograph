import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type {
  Block,
  OperatorDescriptor,
  PlanBlock,
  SequenceBlock,
  TaskBlock,
  Workflow,
} from "../domain/workflow.ts";
import { LIMITS } from "../domain/limits.ts";
import { DEFAULT_PLAN_RECOVERY, type RecoveryPolicy } from "../domain/policy.ts";
import {
  FRONTMATTER_KEYS,
  OPERATOR_KEYS,
  STEP_KEYS,
  assertKeys,
  assertUnique,
  booleanAt,
  MAX_INSTRUCTION_BYTES,
  MAX_WORKFLOW_BYTES,
  NAME_PATTERN,
  parseIdList,
  parseRecovery,
  parseToolList,
  positiveIntAt,
  stringAt,
  VARIABLE_PATTERN,
} from "./schema.ts";
import { objectAt } from "../domain/json.ts";

export interface WorkflowDiagnostic {
  readonly path: string;
  readonly error: string;
}

type ObjectValue = Record<string, unknown>;

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function containedPath(lexicalRoot: string, realRoot: string, configured: string, label: string): string {
  if (isAbsolute(configured)) throw new Error(`${label} must be relative to the workflow directory`);
  const target = resolve(lexicalRoot, configured);
  const lexical = relative(lexicalRoot, target);
  if (escapesRoot(lexical)) throw new Error(`${label} escapes the workflow directory`);
  try {
    const rel = relative(realRoot, realpathSync(target));
    if (escapesRoot(rel)) throw new Error(`${label} escapes the workflow directory`);
    const stats = statSync(target);
    if (!stats.isFile()) throw new Error(`${label} is not a file`);
    if (stats.size > MAX_INSTRUCTION_BYTES) throw new Error(`${label} exceeds ${MAX_INSTRUCTION_BYTES} bytes`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is not a readable file`);
  }
  return target;
}

function deriveTitle(name: string): string {
  return name
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function deriveStepLabel(instruction: string, index: number): string {
  const stem = basename(instruction, extname(instruction));
  const match = stem.match(/^\d+-(.+)$/);
  return match ? match[1] : stem || `step-${index + 1}`;
}

function extractFrontmatter(path: string, label: string): ObjectValue {
  const size = statSync(path).size;
  if (size > MAX_WORKFLOW_BYTES) throw new Error(`${label} exceeds ${MAX_WORKFLOW_BYTES} bytes`);
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error(`${label} must start with frontmatter`);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error(`${label} frontmatter is not closed`);
  const document = parseDocument(lines.slice(1, end).join("\n"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) throw new Error(`invalid YAML: ${document.errors[0].message}`);
  return objectAt(document.toJS({ maxAliasCount: 0 }), `${label} frontmatter`);
}

function loadOperators(directory: string): Map<string, OperatorDescriptor> {
  const operators = new Map<string, OperatorDescriptor>();
  const operatorsDirectory = join(directory, "operators");
  if (!existsSync(operatorsDirectory)) return operators;
  const lexicalRoot = resolve(directory);
  const realRoot = realpathSync(directory);
  let entries;
  try {
    entries = readdirSync(operatorsDirectory, { withFileTypes: true });
  } catch {
    return operators;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
    const id = basename(entry.name, ".md");
    const label = `operators/${entry.name}`;
    if (!NAME_PATTERN.test(id)) throw new Error(`${label} file stem must match ^[a-z][a-z0-9-]*$`);
    const path = containedPath(lexicalRoot, realRoot, `operators/${entry.name}`, label);
    const frontmatter = extractFrontmatter(path, label);
    assertKeys(frontmatter, OPERATOR_KEYS, `${label} frontmatter`);
    operators.set(id, {
      id,
      path,
      description: stringAt(frontmatter.description, `${label} description`),
      ...(frontmatter.tools !== undefined ? { tools: parseToolList(frontmatter.tools, `${label} tools`)! } : {}),
    });
  }
  return operators;
}

interface CompileContext {
  readonly lexicalRoot: string;
  readonly realRoot: string;
  readonly operators: ReadonlyMap<string, OperatorDescriptor>;
  readonly ids: Set<string>;
}

function registerId(context: CompileContext, id: string, label: string): void {
  if (!NAME_PATTERN.test(id)) throw new Error(`${label} id must match ^[a-z][a-z0-9-]*$`);
  if (context.ids.has(id)) throw new Error(`${label} id "${id}" is already used in this workflow`);
  context.ids.add(id);
}

function migrationError(key: string, label: string): never {
  if (key === "kind") throw new Error(`${label}: "kind: planner/executor" was replaced by a "plan:" block; see the workflow schema`);
  if (key === "on") throw new Error(`${label}: "on:" routes were replaced by "repair:" recovery policy; see the workflow schema`);
  if (key === "path") throw new Error(`${label}: "path:" was renamed to "run:"`);
  throw new Error(`unknown ${label} key: ${key}`);
}

function parseStepsList(raw: unknown, label: string, context: CompileContext): Block[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} must be a non-empty list of steps`);
  return raw.map((entry, index) => parseStepEntry(entry, index, `${label}[${index}]`, context));
}

function bodySequence(context: CompileContext, parentId: string, suffix: string, children: readonly Block[]): SequenceBlock {
  const id = `${parentId}-${suffix}`;
  registerId(context, id, `${parentId} body`);
  return { kind: "sequence", id, children };
}

function parseStepEntry(raw: unknown, index: number, label: string, context: CompileContext): Block {
  if (typeof raw === "string") {
    const path = normalizeInstruction(raw, index, label, context);
    const id = deriveStepLabel(raw, index);
    registerId(context, id, label);
    return { kind: "task", id, instructionPath: path } satisfies TaskBlock;
  }
  const entry = objectAt(raw, label);
  const stepKeys = new Set<string>(STEP_KEYS);
  for (const key of Object.keys(entry)) {
    if (stepKeys.has(key)) continue;
    migrationError(key, label);
  }
  const structural = (["plan"] as const).filter((key) => entry[key] !== undefined);
  if (structural.length === 1) {
    const id = stringAt(entry.id, `${label}.id`);
    registerId(context, id, label);
    for (const key of ["run", "tools", "model", "done"] as const) {
      if (entry[key] !== undefined) throw new Error(`${label}.${key} only applies to "run:" tasks`);
    }
    if (entry.repair !== undefined) throw new Error(`${label}.repair only applies to "run:" tasks and "plan:" blocks`);
    return parsePlan(entry.plan, id, label, context);
  }
  const path = normalizeInstruction(stringAt(entry.run, `${label}.run (or a legacy step string)`), index, label, context);
  const id = entry.id === undefined ? deriveStepLabel(entry.run as string, index) : stringAt(entry.id, `${label}.id`);
  registerId(context, id, label);
  return {
    kind: "task",
    id,
    instructionPath: path,
    ...(entry.tools !== undefined ? { tools: parseToolList(entry.tools, `${label}.tools`)! } : {}),
    ...(entry.done !== undefined ? { done: parseIdList(entry.done, `${label}.done`)! } : {}),
    ...(entry.repair !== undefined ? { recovery: parseRecovery(entry.repair, `${label}.repair`)! } : {}),
  } satisfies TaskBlock;
}

function normalizeInstruction(configured: string, index: number, label: string, context: CompileContext): string {
  const entry = configured.replaceAll("\\", "/");
  if (!entry.endsWith(".md")) throw new Error(`${label} must reference a Markdown (.md) file`);
  return containedPath(context.lexicalRoot, context.realRoot, entry, label);
}

function parsePlan(raw: unknown, id: string, label: string, context: CompileContext): PlanBlock {
  const body = objectAt(raw, `${label}.plan`);
  assertKeys(body, ["operators", "repair"], `${label}.plan`);
  const operators = parseIdList(body.operators, `${label}.plan.operators`)!;
  for (const operator of operators) {
    if (!context.operators.has(operator)) throw new Error(`${label}.plan.operators entry "${operator}" has no operator file`);
  }
  const recovery = parseRecovery(body.repair, `${label}.plan.repair`, DEFAULT_PLAN_RECOVERY) ?? DEFAULT_PLAN_RECOVERY;
  return { kind: "plan", id, operators, recovery };
}

export function loadWorkflowManifest(directory: string): Workflow {
  const overviewPath = join(directory, "WORKFLOW.md");
  const data = extractFrontmatter(overviewPath, "WORKFLOW.md");
  assertKeys(data, FRONTMATTER_KEYS, "frontmatter");
  const name = basename(directory);
  if (!NAME_PATTERN.test(name)) throw new Error("workflow directory name must match ^[a-z][a-z0-9-]*$");
  const description = stringAt(data.description, "description");
  const piVisibility = data.piVisibility === undefined ? false : booleanAt(data.piVisibility, "piVisibility");
  if (data.tools !== undefined && data.legalTools !== undefined) throw new Error("tools and legalTools are aliases; configure only one");
  const tools = parseToolList(data.tools ?? data.legalTools, data.tools !== undefined ? "tools" : "legalTools");
  const operators = loadOperators(directory);
  const context: CompileContext = { lexicalRoot: resolve(directory), realRoot: realpathSync(directory), operators, ids: new Set(["root"]) };
  if (!Array.isArray(data.steps) || data.steps.length === 0) throw new Error("steps must be a non-empty list");
  const children = (data.steps as unknown[]).map((entry, index) => parseStepEntry(entry, index, `steps[${index}]`, context));
  return {
    name,
    title: deriveTitle(name),
    description,
    overviewPath,
    piVisibility,
    root: { kind: "sequence", id: "root", children },
    operators,
    ...(tools ? { tools } : {}),
  };
}

export function discoverWorkflows(workflowsRoot: string): {
  workflows: Workflow[];
  diagnostics: WorkflowDiagnostic[];
} {
  const workflows: Workflow[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
  let directoryEntries;
  try {
    directoryEntries = readdirSync(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    if (!(error instanceof Error) || typeof (error as NodeJS.ErrnoException).errno !== "number") throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ path: workflowsRoot, error: error.message });
    }
    return { workflows, diagnostics };
  }
  const directories = directoryEntries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of directories) {
    const directory = join(workflowsRoot, entry.name);
    if (!existsSync(join(directory, "WORKFLOW.md"))) continue;
    try {
      workflows.push(loadWorkflowManifest(directory));
    } catch (error) {
      diagnostics.push({ path: join(directory, "WORKFLOW.md"), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workflows, diagnostics };
}
