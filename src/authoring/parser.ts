import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type {
  Block,
  ContractDescriptor,
  InputBinding,
  LoopBlock,
  OperatorDescriptor,
  PlanBlock,
  ScriptBlock,
  ScriptSpec,
  SequenceBlock,
  TaskBlock,
  Workflow,
} from "../domain/workflow.ts";
import { compileContract } from "../domain/contract.ts";
import { LIMITS } from "../domain/limits.ts";
import { DEFAULT_PLAN_RECOVERY, type RecoveryPolicy } from "../domain/policy.ts";
import {
  FRONTMATTER_KEYS,
  OPERATOR_KEYS,
  STEP_KEYS,
  assertKeys,
  assertUnique,
  booleanAt,
  escapesWorkflowRoot,
  MAX_INSTRUCTION_BYTES,
  MAX_WORKFLOW_BYTES,
  NAME_PATTERN,
  parseGuard,
  parseIdList,
  parseInputBindings,
  parseRecovery,
  parseScriptSpec,
  parseToolList,
  positiveIntAt,
  stringAt,
  VARIABLE_PATTERN,
} from "./schema.ts";
import { objectAt, isValidJsonPointer, type JsonValue } from "../domain/json.ts";
import { ID_PATTERN } from "../domain/limits.ts";

export interface WorkflowDiagnostic {
  readonly path: string;
  readonly error: string;
}

type ObjectValue = Record<string, unknown>;

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function containedPath(lexicalRoot: string, realRoot: string, configured: string, label: string, maxBytes: number = MAX_INSTRUCTION_BYTES): string {
  if (isAbsolute(configured)) throw new Error(`${label} must be relative to the workflow directory`);
  const target = resolve(lexicalRoot, configured);
  const lexical = relative(lexicalRoot, target);
  if (escapesRoot(lexical)) throw new Error(`${label} escapes the workflow directory`);
  try {
    const rel = relative(realRoot, realpathSync(target));
    if (escapesRoot(rel)) throw new Error(`${label} escapes the workflow directory`);
    const stats = statSync(target);
    if (!stats.isFile()) throw new Error(`${label} is not a file`);
    if (stats.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is not a readable file`);
  }
  return target;
}

export function deriveTitle(name: string): string {
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

function readContract(
  contracts: Map<string, ContractDescriptor>,
  id: string,
  configured: string,
  label: string,
  lexicalRoot: string,
  realRoot: string,
): void {
  if (!NAME_PATTERN.test(id)) throw new Error(`${label} id must match ^[a-z][a-z0-9-]*$`);
  const path = containedPath(lexicalRoot, realRoot, configured, label, LIMITS.contractBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const existing = contracts.get(id);
  if (existing && existing.path !== path) throw new Error(`contract id "${id}" is declared more than once`);
  if (!existing) {
    contracts.set(id, { id, path, schema: parsed as JsonValue, validate: compileContract(parsed, label) });
  }
}

function loadContracts(directory: string, configured: unknown): Map<string, ContractDescriptor> {
  const contracts = new Map<string, ContractDescriptor>();
  const lexicalRoot = resolve(directory);
  const realRoot = realpathSync(directory);
  const configuredEntries = configured === undefined ? [] : Object.entries(objectAt(configured, "contracts"));
  if (configuredEntries.length > LIMITS.contractsCount) {
    throw new Error(`contracts must contain at most ${LIMITS.contractsCount} entries`);
  }
  for (const [id, rawPath] of configuredEntries) {
    if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error(`contracts.${id} must be a non-empty path`);
    const normalized = rawPath.trim().replaceAll("\\", "/");
    if (!/^contracts\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.schema\.json$/.test(normalized)) {
      throw new Error(`contracts.${id} must reference a contracts/*.schema.json file inside the workflow directory`);
    }
    readContract(contracts, id, normalized, `contracts.${id}`, lexicalRoot, realRoot);
  }

  const contractsDirectory = join(directory, "contracts");
  if (!existsSync(contractsDirectory)) return contracts;
  try {
    if (!statSync(contractsDirectory).isDirectory()) throw new Error("contracts/ is not a directory");
  } catch (error) {
    throw new Error(`contracts/ is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let entries;
  try {
    entries = readdirSync(contractsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`contracts/ is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".schema.json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > LIMITS.contractsCount) {
    throw new Error(`contracts/ must contain at most ${LIMITS.contractsCount} schema files`);
  }
  const configuredPaths = new Set([...contracts.values()].map((contract) => contract.path));
  for (const entry of files) {
    const id = basename(entry.name, ".schema.json");
    const label = `contracts/${entry.name}`;
    if (!NAME_PATTERN.test(id)) throw new Error(`${label} file stem must match ^[a-z][a-z0-9-]*$`);
    const path = containedPath(lexicalRoot, realRoot, `contracts/${entry.name}`, label, LIMITS.contractBytes);
    if (configured !== undefined) {
      if (!configuredPaths.has(path)) throw new Error(`${label} is not listed in frontmatter contracts`);
      continue;
    }
    readContract(contracts, id, `contracts/${entry.name}`, label, lexicalRoot, realRoot);
  }
  if (contracts.size > LIMITS.contractsCount) throw new Error(`workflow must contain at most ${LIMITS.contractsCount} contracts`);
  return contracts;
}

function loadOperators(directory: string, contracts: ReadonlyMap<string, ContractDescriptor>): Map<string, OperatorDescriptor> {
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
    const output = frontmatter.output === undefined ? undefined : stringAt(frontmatter.output, `${label} output`);
    if (output !== undefined && !contracts.has(output)) {
      throw new Error(`${label} output names contract "${output}", which has no contracts/ file`);
    }
    if (frontmatter.script !== undefined && frontmatter.tools !== undefined) {
      throw new Error(`${label} declares both "script" and "tools"; a process operator takes no tools`);
    }
    const script = frontmatter.script === undefined ? undefined : parseScriptSpec(frontmatter.script, `${label}.script`);
    if (script) assertScriptPaths(script, `${label}.script`, lexicalRoot);
    operators.set(id, {
      id,
      path,
      description: stringAt(frontmatter.description, `${label} description`),
      ...(frontmatter.tools !== undefined ? { tools: parseToolList(frontmatter.tools, `${label} tools`)! } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(script ? { script } : {}),
    });
  }
  return operators;
}

interface CompileContext {
  readonly lexicalRoot: string;
  readonly realRoot: string;
  readonly operators: ReadonlyMap<string, OperatorDescriptor>;
  readonly contracts: ReadonlyMap<string, ContractDescriptor>;
  readonly ids: Set<string>;
  readonly inputEdges: Map<string, string[]>;
  allowItemInputs?: boolean;
}

function registerId(context: CompileContext, id: string, label: string): void {
  if (!NAME_PATTERN.test(id)) throw new Error(`${label} id must match ^[a-z][a-z0-9-]*$`);
  if (context.ids.has(id)) throw new Error(`${label} id "${id}" is already used in this workflow`);
  context.ids.add(id);
}

function recordInputEdges(context: CompileContext, consumerId: string, inputs: Record<string, InputBinding> | undefined, label: string): void {
  if (!inputs) return;
  const producers = context.inputEdges.get(consumerId) ?? [];
  for (const [name, binding] of Object.entries(inputs)) {
    if (binding.from === "$item") {
      if (!context.allowItemInputs) throw new Error(`${label}.${name}.from "$item" is only available inside a loop body`);
      continue;
    }
    if (binding.from === "root" || binding.from === consumerId || !context.ids.has(binding.from)) {
      throw new Error(`${label}.${name}.from names "${binding.from}", which is not an earlier step`);
    }
    if (!producers.includes(binding.from)) producers.push(binding.from);
  }
  context.inputEdges.set(consumerId, producers);
}

function recordGuardEdge(context: CompileContext, consumerId: string, guard: import("../domain/guard.ts").GuardClause | undefined, label: string): void {
  if (!guard) return;
  if (guard.from === "root" || guard.from === consumerId || !context.ids.has(guard.from)) {
    throw new Error(`${label}.when.from names "${guard.from}", which is not an earlier step`);
  }
  const producers = context.inputEdges.get(consumerId) ?? [];
  if (!producers.includes(guard.from)) producers.push(guard.from);
  context.inputEdges.set(consumerId, producers);
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

function scriptStep(entry: ObjectValue, id: string, label: string, context: CompileContext, script: ScriptSpec, output?: string): ScriptBlock {
  const inputs = parseInputBindings(entry.inputs, `${label}.inputs`);
  recordInputEdges(context, id, inputs, label);
  const guard = parseGuard(entry.when, `${label}.when`);
  recordGuardEdge(context, id, guard, `${label}.when`);
  const recovery = entry.repair === undefined ? undefined : parseRecovery(entry.repair, `${label}.repair`);
  return {
    kind: "script",
    id,
    script,
    ...(recovery ? { recovery } : {}),
    ...(inputs ? { inputs } : {}),
    ...(guard ? { guard } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function parseStepEntry(raw: unknown, index: number, label: string, context: CompileContext): Block {
  if (typeof raw === "string") {
    const path = normalizeInstruction(raw, index, label, context);
    const id = deriveStepLabel(raw, index);
    registerId(context, id, label);
    return { kind: "task", id, instructionPath: path } satisfies TaskBlock;
  }
  const entry = objectAt(raw, label);
  for (const key of Object.keys(entry)) {
    if (new Set<string>(STEP_KEYS).has(key)) continue;
    throw new Error(`unknown ${label} key: ${key}`);
  }
  const loopKeys = (["for_each", "repeat_until"] as const).filter((key) => entry[key] !== undefined);
  if (loopKeys.length > 1) throw new Error(`${label} declares more than one of: ${loopKeys.join(", ")}`);
  if (loopKeys.length === 1) {
    const id = stringAt(entry.id, `${label}.id`);
    registerId(context, id, label);
    for (const key of ["run", "tools", "done", "output", "plan"] as const) {
      if (entry[key] !== undefined) throw new Error(`${label}.${key} only applies to "run:" tasks`);
    }
    for (const key of ["script", "operator"] as const) {
      if (entry[key] !== undefined) throw new Error(`${label}.${key} cannot be combined with "${loopKeys[0]}"`);
    }
    const inputs = parseInputBindings(entry.inputs, `${label}.inputs`);
    recordInputEdges(context, id, inputs, label);
    const guard = parseGuard(entry.when, `${label}.when`);
    recordGuardEdge(context, id, guard, `${label}.when`);
    const block = parseLoop(loopKeys[0], entry[loopKeys[0]], id, label, context);
    return { ...(guard ? { guard } : {}), ...block, ...(inputs ? { inputs } : {}) };
  }
  if (entry.operator !== undefined) {
    for (const key of ["run", "tools", "done", "output", "plan", "script", "for_each", "repeat_until"] as const) {
      if (entry[key] !== undefined) throw new Error(`${label}.${key} cannot be combined with "operator"`);
    }
    const id = stringAt(entry.id, `${label}.id`);
    registerId(context, id, label);
    const operatorId = stringAt(entry.operator, `${label}.operator`);
    const operator = context.operators.get(operatorId);
    if (!operator) throw new Error(`${label}.operator names "${operatorId}", which has no operator file`);
    if (!operator.script) throw new Error(`${label}.operator "${operatorId}" is a model operator; steps support process operators only`);
    return scriptStep(entry, id, label, context, operator.script, operator.output);
  }
  const structural = (["plan", "script"] as const).filter((key) => entry[key] !== undefined);
  if (structural.length > 1) throw new Error(`${label} declares more than one of: ${structural.join(", ")}`);
  if (structural[0] === "script") {
    const id = stringAt(entry.id, `${label}.id`);
    registerId(context, id, label);
    for (const key of ["run", "tools", "done", "plan"] as const) {
      if (entry[key] !== undefined) throw new Error(`${label}.${key} only applies to "run:" tasks`);
    }
    const output = entry.output === undefined ? undefined : stringAt(entry.output, `${label}.output`);
    if (output !== undefined && !context.contracts.has(output)) {
      throw new Error(`${label}.output names contract "${output}", which has no contracts/ file`);
    }
    const spec = parseScriptSpec(entry.script, `${label}.script`);
    assertScriptPaths(spec, `${label}.script`, context.lexicalRoot);
    return scriptStep(entry, id, label, context, spec, output);
  }
  if (structural.length === 1) {
    const id = stringAt(entry.id, `${label}.id`);
    registerId(context, id, label);
    for (const key of ["run", "tools", "model", "done", "output"] as const) {
      if (entry[key] !== undefined) throw new Error(`${label}.${key} only applies to "run:" tasks`);
    }
    if (entry.repair !== undefined) throw new Error(`${label}.repair only applies to "run:" tasks and "plan:" blocks`);
    const inputs = parseInputBindings(entry.inputs, `${label}.inputs`);
    recordInputEdges(context, id, inputs, label);
    const guard = parseGuard(entry.when, `${label}.when`);
    recordGuardEdge(context, id, guard, `${label}.when`);
    const block = parsePlan(entry.plan, id, label, context);
    return { ...(guard ? { guard } : {}), ...block, ...(inputs ? { inputs } : {}) };
  }
  const path = normalizeInstruction(stringAt(entry.run, `${label}.run (or a legacy step string)`), index, label, context);
  const id = entry.id === undefined ? deriveStepLabel(entry.run as string, index) : stringAt(entry.id, `${label}.id`);
  registerId(context, id, label);
  const inputs = parseInputBindings(entry.inputs, `${label}.inputs`);
  recordInputEdges(context, id, inputs, label);
  const guard = parseGuard(entry.when, `${label}.when`);
  recordGuardEdge(context, id, guard, `${label}.when`);
  const output = entry.output === undefined ? undefined : stringAt(entry.output, `${label}.output`);
  if (output !== undefined && !context.contracts.has(output)) {
    throw new Error(`${label}.output names contract "${output}", which has no contracts/ file`);
  }
  return {
    kind: "task",
    id,
    instructionPath: path,
    ...(entry.tools !== undefined ? { tools: parseToolList(entry.tools, `${label}.tools`)! } : {}),
    ...(entry.done !== undefined ? { done: parseIdList(entry.done, `${label}.done`)! } : {}),
    ...(entry.repair !== undefined ? { recovery: parseRecovery(entry.repair, `${label}.repair`)! } : {}),
    ...(inputs ? { inputs } : {}),
    ...(guard ? { guard } : {}),
    ...(output !== undefined ? { output } : {}),
  } satisfies TaskBlock;
}

function assertScriptPaths(spec: ScriptSpec, label: string, workflowRoot: string): void {
  if (spec.cwd !== ".") {
    const target = resolve(workflowRoot, spec.cwd);
    const rel = relative(workflowRoot, target);
    if (escapesWorkflowRoot(rel)) throw new Error(`${label}.cwd escapes the workflow directory`);
  }
  (spec.files ?? []).forEach((capture, index) => {
    const target = resolve(workflowRoot, spec.cwd, capture.path);
    const rel = relative(workflowRoot, target);
    if (escapesWorkflowRoot(rel)) throw new Error(`${label}.files[${index}].path escapes the workflow directory`);
  });
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

const LOOP_KEYS = ["items", "body", "maxItems", "maxIterations", "when"] as const;

function parseBodySteps(raw: unknown, label: string, context: CompileContext): readonly Block[] {
  const body = objectAt(raw, label);
  if (body.steps === undefined) return [parseBodyStep(body, label, context)];
  if (body.run !== undefined || body.inputs !== undefined) {
    throw new Error(`${label} declares both "run" and "steps"; a loop body picks one form`);
  }
  for (const key of Object.keys(body)) {
    if (key !== "steps") throw new Error(`${label}.${key} is not accepted; a loop body holds "run" (one step) or "steps" (a list of steps)`);
  }
  const steps = parseStepsList(body.steps, `${label}.steps`, context);
  if (steps.length > LIMITS.checkpointListItems) {
    throw new Error(`${label}.steps holds ${steps.length} entries; a loop body holds at most ${LIMITS.checkpointListItems}`);
  }
  for (const step of steps) {
    if (step.kind === "loop") throw new Error(`${label}.steps must not nest loops; nested loops are not supported`);
    if (step.kind === "plan") throw new Error(`${label}.steps must not contain a plan; plans are not accepted inside a loop body`);
  }
  return steps;
}

function parseBodyStep(raw: unknown, label: string, context: CompileContext): TaskBlock {
  const body = objectAt(raw, label);
  for (const key of Object.keys(body)) {
    if (key !== "run" && key !== "inputs") throw new Error(`${label}.${key} is not accepted; a loop body holds "run" (one step) or "steps" (a list of steps)`);
  }
  const configured = stringAt(body.run, `${label}.run`);
  const path = normalizeInstruction(configured, 0, label, context);
  const id = deriveStepLabel(configured, 0);
  registerId(context, id, label);
  const inputs = parseInputBindings(body.inputs, `${label}.inputs`);
  recordInputEdges(context, id, inputs, `${label}.inputs`);
  return { kind: "task", id, instructionPath: path, ...(inputs ? { inputs } : {}) };
}

function parseLoop(kind: "for_each" | "repeat_until", raw: unknown, id: string, label: string, context: CompileContext): LoopBlock {
  const body = objectAt(raw, `${label}.${kind}`);
  assertKeys(body, LOOP_KEYS, `${label}.${kind}`);
  const bodyContext: CompileContext = { ...context, allowItemInputs: true };
  const children = parseBodySteps(body.body, `${label}.${kind}.body`, bodyContext);
  const sequence = bodySequence(context, id, "body", children);
  if (kind === "for_each") {
    if (body.when !== undefined) throw new Error(`${label}.for_each.when is only accepted by repeat_until`);
    const itemsRaw = objectAt(body.items, `${label}.for_each.items`);
    const itemKeys = Object.keys(itemsRaw);
    for (const key of itemKeys) {
      if (key !== "from" && key !== "select") throw new Error(`${label}.for_each.items.${key} is not an accepted binding field`);
    }
    const from = stringAt(itemsRaw.from, `${label}.for_each.items.from`);
    if (!ID_PATTERN.test(from)) throw new Error(`${label}.for_each.items.from must match ^[a-z][a-z0-9-]*$`);
    let select: string | undefined;
    if (itemsRaw.select !== undefined) {
      if (typeof itemsRaw.select !== "string") throw new Error(`${label}.for_each.items.select must be a JSON Pointer such as /data/files`);
      select = itemsRaw.select;
      if (!isValidJsonPointer(select)) throw new Error(`${label}.for_each.items.select must be a JSON Pointer such as /data/files`);
    }
    const itemsBinding: InputBinding = select === undefined ? { from } : { from, select };
    if (from === "root" || from === id || !context.ids.has(from)) {
      throw new Error(`${label}.for_each.items.from names "${from}", which is not an earlier step`);
    }
    const producers = context.inputEdges.get(id) ?? [];
    if (!producers.includes(from)) producers.push(from);
    context.inputEdges.set(id, producers);
    const maxItems = positiveIntAt(body.maxItems, `${label}.for_each.maxItems`, LIMITS.checkpointListItems);
    const recovery = parseRecovery(body.repair, `${label}.for_each.repair`);
    return {
      kind: "loop",
      id,
      mode: "for-each",
      body: sequence,
      itemsBinding,
      maxIterations: maxItems,
      ...(recovery ? { recovery } : {}),
    };
  }
  if (body.items !== undefined) throw new Error(`${label}.repeat_until.items is only accepted by for_each`);
  const condition = parseGuard(body.when, `${label}.repeat_until.when`)!;
  if (condition.from === "root" || condition.from === id || !context.ids.has(condition.from)) {
    throw new Error(`${label}.repeat_until.when.from names "${condition.from}", which is not an earlier step`);
  }
  const producers = context.inputEdges.get(id) ?? [];
  if (!producers.includes(condition.from)) producers.push(condition.from);
  context.inputEdges.set(id, producers);
  const maxIterations = positiveIntAt(body.maxIterations, `${label}.repeat_until.maxIterations`, LIMITS.checkpointListItems);
  const recovery = parseRecovery(body.repair, `${label}.repeat_until.repair`);
  return {
    kind: "loop",
    id,
    mode: "repeat-until",
    body: sequence,
    condition,
    maxIterations,
    ...(recovery ? { recovery } : {}),
  };
}

export function loadWorkflowManifest(directory: string): Workflow {
  const overviewPath = join(directory, "WORKFLOW.md");
  const data = extractFrontmatter(overviewPath, "WORKFLOW.md");
  assertKeys(data, FRONTMATTER_KEYS, "frontmatter");
  const name = basename(directory);
  if (!NAME_PATTERN.test(name)) throw new Error("workflow directory name must match ^[a-z][a-z0-9-]*$");
  const description = stringAt(data.description, "description");
  const piVisibility = data.piVisibility === undefined ? false : booleanAt(data.piVisibility, "piVisibility");
  const tools = parseToolList(data.legalTools, "legalTools");
  const contracts = loadContracts(directory, data.contracts);
  const operators = loadOperators(directory, contracts);
  const context: CompileContext = { lexicalRoot: resolve(directory), realRoot: realpathSync(directory), operators, contracts, ids: new Set(["root"]), inputEdges: new Map() };
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
    contracts,
    inputEdges: context.inputEdges,
    ...(tools ? { tools } : {}),
  };
}

function resolvesToDirectory(root: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(root, entry.name)).isDirectory();
  } catch {
    return false;
  }
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
    .filter((entry) => resolvesToDirectory(workflowsRoot, entry))
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
