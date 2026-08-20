import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { WorkflowDescriptor, WorkflowDiagnostic, WorkflowStep } from "./types.ts";

const MAX_WORKFLOW_BYTES = 128_000;
const MAX_STEP_BYTES = 128_000;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const FRONTMATTER_KEYS = ["description", "steps", "piVisibility", "legalTools"];

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

function extractFrontmatter(path: string): ObjectValue {
  const size = statSync(path).size;
  if (size > MAX_WORKFLOW_BYTES) throw new Error(`WORKFLOW.md exceeds ${MAX_WORKFLOW_BYTES} bytes`);
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("WORKFLOW.md must start with frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("WORKFLOW.md frontmatter is not closed");
  const document = parseDocument(lines.slice(1, end).join("\n"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) throw new Error(`invalid YAML: ${document.errors[0].message}`);
  return objectAt(document.toJS({ maxAliasCount: 0 }), "frontmatter");
}

function parseLegalTools(raw: unknown): Set<string> | undefined {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
  if (!Array.isArray(raw)) throw new Error("legalTools must be a list");
  const tools = raw.map((value, index) => {
    const tool = stringAt(value, `legalTools[${index}]`);
    if (!TOOL_NAME_PATTERN.test(tool)) throw new Error(`legalTools[${index}] must match ^[a-z][a-z0-9_]*$`);
    return tool;
  });
  assertUnique(tools, "legalTools");
  return new Set(tools);
}

function parseSteps(raw: unknown, root: string): WorkflowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("steps must be a non-empty list");
  const lexicalRoot = resolve(root);
  const realRoot = realpathSync(root);
  const steps = raw.map((value, index) => {
    const entry = stringAt(value, `steps[${index}]`).replaceAll("\\", "/");
    if (!entry.endsWith(".md")) throw new Error(`steps[${index}] must be a Markdown (.md) file`);
    const path = containedPath(lexicalRoot, realRoot, entry, `steps[${index}]`);
    return { label: deriveStepLabel(entry, index), path };
  });
  assertUnique(steps.map((step) => step.path), "steps");
  return steps;
}

export function loadWorkflowManifest(directory: string): WorkflowDescriptor {
  const overviewPath = join(directory, "WORKFLOW.md");
  const data = extractFrontmatter(overviewPath);
  assertKeys(data, FRONTMATTER_KEYS, "frontmatter");
  const name = basename(directory);
  if (!NAME_PATTERN.test(name)) throw new Error("workflow directory name must match ^[a-z][a-z0-9-]*$");
  const description = stringAt(data.description, "description");
  const piVisibility = data.piVisibility === undefined ? false : booleanAt(data.piVisibility, "piVisibility");
  const steps = parseSteps(data.steps, directory);
  const legalTools = parseLegalTools(data.legalTools);
  return {
    name,
    title: deriveTitle(name),
    description,
    overviewPath,
    steps,
    piVisibility,
    ...(legalTools ? { legalTools } : {}),
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
