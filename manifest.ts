import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { OperatorDescriptor, StepKind, StepRoutes, WorkflowDescriptor, WorkflowDiagnostic, WorkflowStep } from "./types.ts";

const MAX_WORKFLOW_BYTES = 128_000;
const MAX_STEP_BYTES = 128_000;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MODEL_SELECTOR_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const FRONTMATTER_KEYS = ["description", "steps", "piVisibility", "tools", "legalTools", "model"];
const STEP_KEYS = ["path", "id", "kind", "tools", "model", "done", "on"];
const ROUTE_KEYS = ["pass", "rework", "replan"];
const KINDS: readonly StepKind[] = ["planner", "executor"];
const OPERATOR_KEYS = ["description", "tools"];

type ObjectValue = Record<string, unknown>;

function objectAt(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}

function stringAt(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function booleanAt(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function assertKeys(value: ObjectValue, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`unknown ${label} key: ${key}`);
}

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
    if (stats.size > MAX_STEP_BYTES) throw new Error(`${label} exceeds ${MAX_STEP_BYTES} bytes`);
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

function parseToolList(raw: unknown, label: string): Set<string> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${label} must be a list`);
  const tools = raw.map((value, index) => {
    const tool = stringAt(value, `${label}[${index}]`);
    if (!TOOL_NAME_PATTERN.test(tool)) throw new Error(`${label}[${index}] must match ^[a-z][a-z0-9_]*$`);
    return tool;
  });
  assertUnique(tools, label);
  return new Set(tools);
}

function parseModelSelector(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  const selector = stringAt(raw, label);
  if (!MODEL_SELECTOR_PATTERN.test(selector)) throw new Error(`${label} must be a provider/model-id selector such as anthropic/claude-haiku-4-5`);
  return selector;
}

function parseIdList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} must be a non-empty list`);
  const ids = raw.map((value, index) => {
    const id = stringAt(value, `${label}[${index}]`);
    if (!NAME_PATTERN.test(id)) throw new Error(`${label}[${index}] must match ^[a-z][a-z0-9-]*$`);
    return id;
  });
  assertUnique(ids, label);
  return ids;
}

function parseRoutes(raw: unknown, label: string): StepRoutes | undefined {
  if (raw === undefined) return undefined;
  const routes = objectAt(raw, label);
  assertKeys(routes, ROUTE_KEYS, `${label}`);
  const result: Record<string, string> = {};
  for (const key of ROUTE_KEYS) {
    if (routes[key] === undefined) continue;
    result[key] = stringAt(routes[key], `${label}.${key}`);
  }
  return result as StepRoutes;
}
function parseStepEntry(raw: unknown, index: number): { path: string; options: ObjectValue | undefined } {
  if (typeof raw === "string") return { path: stringAt(raw, `steps[${index}]`), options: undefined };
  const entry = objectAt(raw, `steps[${index}]`);
  assertKeys(entry, STEP_KEYS, `steps[${index}]`);
  return { path: stringAt(entry.path, `steps[${index}].path`), options: entry };
}

function parseSteps(raw: unknown, root: string): { steps: WorkflowStep[]; structured: boolean } {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("steps must be a non-empty list");
  const lexicalRoot = resolve(root);
  const realRoot = realpathSync(root);
  const structured = raw.some((value) => value !== null && typeof value === "object");
  const entries = raw.map((value, index) => parseStepEntry(value, index));
  const steps: WorkflowStep[] = entries.map(({ path, options }, index) => {
    const entry = path.replaceAll("\\", "/");
    if (!entry.endsWith(".md")) throw new Error(`steps[${index}] must be a Markdown (.md) file`);
    const filePath = containedPath(lexicalRoot, realRoot, entry, `steps[${index}]`);
    const label = deriveStepLabel(entry, index);
    if (!options) return { path: filePath, label, id: label, kind: "static" as const };
    const id = options.id === undefined ? label : stringAt(options.id, `steps[${index}].id`);
    if (structured && !NAME_PATTERN.test(id)) {
      throw new Error(`steps[${index}].id must match ^[a-z][a-z0-9-]*$: set an explicit id for "${label}"`);
    }
    if (options.kind !== undefined && !(KINDS as readonly string[]).includes(options.kind as string)) {
      throw new Error(`steps[${index}].kind must be planner or executor`);
    }
    const kind: StepKind = (options.kind as StepKind | undefined) ?? "static";
    const done = options.done === undefined ? undefined : parseIdList(options.done, `steps[${index}].done`);
    return {
      path: filePath,
      label,
      id,
      kind,
      ...(options.tools !== undefined ? { tools: parseToolList(options.tools, `steps[${index}].tools`)! } : {}),
      ...(options.model !== undefined ? { model: parseModelSelector(options.model, `steps[${index}].model`)! } : {}),
      ...(done ? { done } : {}),
      ...(options.on !== undefined ? { on: parseRoutes(options.on, `steps[${index}].on`)! } : {}),
    };
  });
  assertUnique(steps.map((step) => step.path), "steps");
  assertUnique(steps.map((step) => step.id), "step ids");
  return { steps, structured };
}

function validateStepGraph(steps: readonly WorkflowStep[], operators: ReadonlyMap<string, OperatorDescriptor>): void {
  const ids = new Set(steps.map((step) => step.id));
  steps.forEach((step, index) => {
    for (const route of ["pass", "rework", "replan"] as const) {
      const target = step.on?.[route];
      if (target !== undefined && !ids.has(target)) {
        throw new Error(`steps[${index}].on.${route} targets unknown step id: ${target}`);
      }
    }
  });
  const planners = steps.filter((step) => step.kind === "planner");
  const executors = steps.filter((step) => step.kind === "executor");
  if (planners.length === 0 && executors.length === 0) return;
  if (planners.length !== 1) throw new Error("a structured workflow needs exactly one planner step");
  if (executors.length !== 1) throw new Error("a structured workflow needs exactly one executor step");
  const planAt = steps.indexOf(planners[0]);
  const executeAt = steps.indexOf(executors[0]);
  if (executeAt < planAt) throw new Error("the executor step must come after the planner step");
  if (operators.size === 0) throw new Error("a planner step requires at least one operator in operators/");
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

export function loadWorkflowManifest(directory: string): WorkflowDescriptor {
  const overviewPath = join(directory, "WORKFLOW.md");
  const data = extractFrontmatter(overviewPath, "WORKFLOW.md");
  assertKeys(data, FRONTMATTER_KEYS, "frontmatter");
  const name = basename(directory);
  if (!NAME_PATTERN.test(name)) throw new Error("workflow directory name must match ^[a-z][a-z0-9-]*$");
  const description = stringAt(data.description, "description");
  const piVisibility = data.piVisibility === undefined ? false : booleanAt(data.piVisibility, "piVisibility");
  if (data.tools !== undefined && data.legalTools !== undefined) throw new Error("tools and legalTools are aliases; configure only one");
  const tools = parseToolList(data.tools ?? data.legalTools, data.tools !== undefined ? "tools" : "legalTools");
  const { steps, structured } = parseSteps(data.steps, directory);
  const operators = loadOperators(directory);
  if (structured) validateStepGraph(steps, operators);
  return {
    name,
    title: deriveTitle(name),
    description,
    overviewPath,
    steps,
    piVisibility,
    structured,
    operators,
    ...(tools ? { tools } : {}),
    ...(data.model !== undefined ? { model: parseModelSelector(data.model, "model")! } : {}),
  };
}

export function discoverWorkflows(workflowsRoot: string): {
  workflows: WorkflowDescriptor[];
  diagnostics: WorkflowDiagnostic[];
} {
  const workflows: WorkflowDescriptor[] = [];
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
