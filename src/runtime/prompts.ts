import { parseDocument } from "yaml";
import { currentPosition } from "../engine/interpreter.ts";
import { CONTROL_TOOLS, RETRY_TOOL_NAME } from "./capabilities.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import type { Execution, PlanExecution } from "../domain/execution.ts";
import { canonicalJson, canonicalJsonBytes } from "../domain/json.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts"
import type { Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { lastSegment } from "../domain/keys.ts";
import type { LoopFrame } from "../domain/execution.ts";
import { type RefValueLoader } from "./artifacts.ts";
import { inputSection } from "./prompts-inputs.ts";

type ReadBlock = (path: string, label: string) => string;

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let clipped = value;
  while (Buffer.byteLength(clipped, "utf8") > maxBytes - 3) clipped = clipped.slice(0, Math.max(0, clipped.length - 16));
  return `${clipped}...`;
}

export function readBlockFrom(fs: { readFileSync(path: string, encoding: "utf8"): string }): ReadBlock {
  return (path: string, label: string): string => {
    try {
      const content = fs.readFileSync(path, "utf8");
      if (Buffer.byteLength(content, "utf8") > LIMITS.instructionFileBytes) {
        return `${label} exceeds ${LIMITS.instructionFileBytes} bytes; restore or edit the file, or abort the run.`;
      }
      return content;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `${label} unavailable: ${detail}. Restore the file or abort the run.`;
    }
  };
}

function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return text;
  if (!/^[ \t]*[A-Za-z_-][A-Za-z0-9_-]*[ \t]*:/.test(match[1])) return text;
  try {
    const document = parseDocument(match[1], { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0) return text;
    const value = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return text;
    return text.slice(match[0].length);
  } catch {
    return text;
  }
}

function readBody(read: ReadBlock, path: string, label: string): string {
  return stripFrontmatter(read(path, label)).trim();
}

function toolsSection(tools: readonly string[] | undefined): string {
  if (!tools) return "";
  const granted = tools.filter((name) => !CONTROL_TOOLS.includes(name) && name !== RETRY_TOOL_NAME);
  const lines = [
    "## Tools",
    `Tools granted at this position: ${granted.length ? granted.map((name) => `\`${name}\``).join(", ") : "none beyond the workflow controls above"}.`,
    "Tools not listed are unavailable here; do not attempt to use them.",
  ];
  if (granted.includes("bash")) lines.push("Use bash (`ls`, `find`, `rg`) to discover files; never guess paths.");
  return lines.join("\n");
}

const TRANSITION_CONTRACT = [
  "## Transition contract",
  "Conclude the current position with exactly one `workflow_transition` call.",
  "- `status`: `completed` when the criteria are met, `needs-work` when the output has problems, or `blocked` when you cannot proceed.",
  "- `met`: the required criterion IDs below that are complete, copied verbatim. Only valid with `status: \"completed\"`; a completion must list every required criterion.",
  "- `checkpoint`: an object with a required `summary` and optional `evidence`, `decisions`, `unknowns`, and `data` fields. No other fields exist at the top level or inside `checkpoint`; structured output goes inside `checkpoint.data`.",
  "- Caps: `evidence`/`decisions`/`unknowns` at most " + LIMITS.checkpointListItems + " items of " + LIMITS.checkpointItemBytes + " bytes each; `summary` at most " + LIMITS.checkpointSummaryBytes / 1024 + " KiB; the whole checkpoint at most " + LIMITS.checkpointBytes / 1024 + " KiB.",
  "- `checkpoint.data` must satisfy the current position's declared output contract when one exists.",
  "- `issues`: problems found, each `{ target, reason }`. Only valid with `status: \"needs-work\"`; recovery policy decides what happens next.",
  "A rejected transition reports every violation at once and changes nothing. Example of the exact shape:",
  '`{ "status": "completed", "met": ["first-criterion-id"], "checkpoint": { "summary": "...", "evidence": ["..."], "data": { "...": "position-specific output" } } }`',
].join("\n");

function priorCheckpoints(workflow: Workflow, state: Execution, beforeKey: string): string {
  const order = state.checkpointOrder ?? Object.keys(state.checkpoints);
  const prior = order.filter((key) => key !== beforeKey && !key.startsWith(`${beforeKey}/`));
  if (prior.length === 0) return "";
  const lines = prior.slice(-8).map((key) => `- \`${lastSegment(key)}\`: ${state.checkpoints[key].summary}`);
  return lines.length ? ["## Prior checkpoints", ...lines].join("\n") : "";
}

function criteriaList(done: readonly string[] | undefined): string {
  if (!done || done.length === 0) return "Required criteria: none";
  return ["Required criteria:", ...done.map((id) => `- \`${id}\``)].join("\n");
}

function loopContext(workflow: Workflow, state: Execution, positionKey: string): string {
  const frame = [...state.stack].reverse().find((entry): entry is LoopFrame => entry.kind === "loop" && positionKey.startsWith(`${entry.key}/`));
  if (!frame) return "";
  const block = blockOf(workflow, frame.blockId);
  const loopState = state.loops[frame.key];
  if (block?.kind !== "loop" || !loopState) return "";
  const total = loopState.items?.length ?? 0;
  const item = loopState.items && loopState.items[loopState.iteration - 1] !== undefined
    ? `\nCurrent item: ${clip(canonicalJson(loopState.items[loopState.iteration - 1]), 512)}`
    : "";
  return [`## Loop context`, `Loop \`${block.id}\` (for each), iteration ${loopState.iteration} of ${total}.${item}`].join("\n");
}

function operatorRoster(workflow: Workflow, allowed: readonly string[]): string {
  const lines = allowed
    .map((id) => workflow.operators.get(id))
    .filter((operator): operator is NonNullable<typeof operator> => Boolean(operator))
    .map((operator) => `- \`${operator.id}\`: ${operator.description}`);
  return ["## Operator registry", ...lines].join("\n");
}

function outputContractSection(workflow: Workflow, contractId: string | undefined): string {
  if (contractId === undefined) return "";
  const contract = workflow.contracts?.get(contractId);
  if (!contract) return ["## Output contract", `Contract \`${contractId}\` is unavailable.`, "The transition will be rejected until the workflow declares this contract."].join("\n");
  const schema = contract.schema === undefined ? "Schema is unavailable in this workflow descriptor." : canonicalJson(contract.schema);
  const bounded = contract.schema === undefined || canonicalJsonBytes(contract.schema) <= LIMITS.positionInputsBytes
    ? schema
    : `Schema omitted because it exceeds ${LIMITS.positionInputsBytes} bytes; contract source: ${contract.path}`;
  return [
    "## Output contract",
    `Contract: \`${contractId}\``,
    "Set `checkpoint.data` to a JSON value that satisfies this schema.",
    "```json",
    bounded,
    "```",
  ].join("\n");
}

const PLAN_SCHEMA_SECTION = [
  "## Plan schema",
  "On completion, `checkpoint.data.plan` must be a JSON object:",
  '`{ "version": 1, "nodes": [ { "id", "operator", "objective", "dependsOn"?, "evidence"?, "done" } ] }`',
  `- 2 to ${LIMITS.planNodes} nodes; unique ids matching ${ID_PATTERN}; each operator must appear in the registry above.`,
  "- `dependsOn` names only earlier nodes in declaration order.",
  "- `done` lists 1 to " + LIMITS.planNodeListItems + " criterion ids for this node's completion; each entry must match " + ID_PATTERN + " (lowercase ids like `paths-mapped`, never prose sentences).",
  '- Nodes whose operator is marked "(process)" run as a local process with no model turn: they take neither `done` nor `evidence`, and receive their `dependsOn` results as JSON on stdin.',
  `- Unknown keys and plans above ${LIMITS.planBytes / 1024} KiB are rejected.`,
].join("\n");


export function renderPrompt(workflow: Workflow, state: Execution, read: ReadBlock, load?: RefValueLoader, tools?: readonly string[], hasHandoffCapsule = false): string {
  const position = currentPosition(workflow, state);
  if (!position) return "";
  const header = [
    "# Active workflow",
    `Workflow: ${workflow.title} (\`${workflow.name}\`) - ${workflow.description}`,
    `Run: \`${state.runId}\``,
    state.target ? `Target: ${state.target}` : "",
    `Position: \`${position.key}\` (attempt ${position.attempt})`,
    "",
    "You are mid-workflow. Treat the instructions below as authoritative; earlier instructions are superseded.",
  ];
  const controls = ["## Controls", "- `workflow_transition` - conclude the current position once its criteria are met or problems are found.", "- `workflow_handoff_read` - retrieve exact handoff detail by checksum only when the protected capsule says it is needed.", "- `workflow_abort` - stop the run when the user asks or it cannot continue."];
  if (position.type === "task") {
    return [
      ...header,
      "",
      ...controls,
      "",
      toolsSection(tools),
      "",
      "## Workflow overview",
      "",
      readBody(read, workflow.overviewPath, "Workflow overview"),
      inputSection(workflow, state, position.task!.inputs, load),
      hasHandoffCapsule || position.task!.inputs ? "" : priorCheckpoints(workflow, state, position.key),
      loopContext(workflow, state, position.key),
      "## Current task instructions",
      "",
      readBody(read, position.task!.instructionPath, "Task instructions"),
      outputContractSection(workflow, position.task!.output),
      criteriaList(position.task!.done),
      TRANSITION_CONTRACT,
    ]
      .filter((section) => section !== "")
      .join("\n\n");
  }
  if (position.type === "plan-create") {
    const sections = [
      ...header,
      "",
      ...controls,
      "",
      toolsSection(tools),
      "",
      "## Task: create a bounded plan",
      "",
      `Compose a plan of ${position.plan!.operators.length === 1 ? "2 to 8" : "2 to 8"} nodes using only the trusted operators below.`,
      "## Workflow overview",
      "",
      readBody(read, workflow.overviewPath, "Workflow overview"),
      inputSection(workflow, state, position.plan!.inputs, load),
      operatorRoster(workflow, position.plan!.operators),
      PLAN_SCHEMA_SECTION,
    ];
    sections.push(TRANSITION_CONTRACT);
    return sections.filter((section) => section !== "").join("\n\n");
  }
  const node = position.node!;
  const operator = workflow.operators.get(node.operator)!;
  const execution = position.execution!;
  const dependencyEntries = (node.dependsOn ?? [])
    .filter((dependency) => Object.hasOwn(execution.results, dependency))
    .map((dependency) => ({ dependency, result: execution.results[dependency] }))
    .map((entry) => {
      const producer = execution.plan.nodes.find((candidate) => candidate.id === entry.dependency);
      const operatorId = producer?.operator;
      const producerOperator = operatorId ? workflow.operators?.get(operatorId) : undefined;
      if (!producerOperator?.output) return { ...entry, operator: undefined, value: undefined };
      const value = entry.result.data === undefined ? {} : entry.result.data;
      return { ...entry, operator: producerOperator, value };
    });
  const dataEntries = dependencyEntries.filter((entry): entry is typeof entry & { operator: NonNullable<typeof entry.operator>; value: NonNullable<typeof entry.value> } => Boolean(entry.operator && entry.value !== undefined));
  const dependencyLine = (entry: (typeof dependencyEntries)[number], omitted = false): string => {
    const summary = clip(entry.result.summary, 1_024);
    if (!entry.operator || entry.value === undefined) return `- \`${clip(entry.dependency, 256)}\`: ${summary}`;
    const data = omitted
      ? `Input omitted because the dependency data exceeds the shared ${LIMITS.positionInputsBytes}-byte budget. ${entry.value !== null && typeof entry.value === "object" && !Array.isArray(entry.value) ? `Top-level keys: ${clip(Object.keys(entry.value).join(", ") || "(none)", 512)}.` : "Use a narrower dependency or revise the plan."}`
      : canonicalJson(entry.value);
    return `- \`${clip(entry.dependency, 256)}\` [${entry.operator.id}, contract \`${entry.operator.output}\`]: ${summary}\n\`\`\`json\n${data}\n\`\`\``;
  };
  let renderedDependencies = dependencyEntries.map((entry) => dependencyLine(entry));
  const renderedDependencyBytes = (): number => Buffer.byteLength(["## Dependency results", ...renderedDependencies].join("\n"), "utf8");
  for (const entry of [...dataEntries].sort((left, right) => Buffer.byteLength(dependencyLine(right), "utf8") - Buffer.byteLength(dependencyLine(left), "utf8") || left.dependency.localeCompare(right.dependency))) {
    if (renderedDependencyBytes() <= LIMITS.positionInputsBytes) break;
    renderedDependencies = renderedDependencies.map((line, index) => (dependencyEntries[index].dependency === entry.dependency ? dependencyLine(entry, true) : line));
  }
  const dependencies = renderedDependencies;
  const unknowns = execution.plan.nodes
    .map((entry) => (Object.hasOwn(execution.results, entry.id) ? execution.results[entry.id].unknowns ?? [] : []))
    .flat()
    .slice(0, LIMITS.planNodeListItems);
  const nodeIndex = execution.plan.nodes.findIndex((entry) => entry.id === node.id);
  return [
    ...header,
    `Node ${nodeIndex + 1}/${execution.plan.nodes.length}: \`${node.id}\``,
    "",
    ...controls,
    "",
    toolsSection(tools),
    "",
    `## Operator: ${operator.id}`,
    "",
    readBody(read, operator.path, "Operator instructions"),
    outputContractSection(workflow, operator.output),
    dependencies.length ? ["## Dependency results", ...dependencies].join("\n") : "",
    unknowns.length ? ["## Open unknowns", ...unknowns.map((item) => `- ${item}`)].join("\n") : "",
    "## Node objective",
    "",
    node.objective,
    ...(node.evidence ?? []).length ? ["", "Expected evidence:", ...(node.evidence ?? []).map((item) => `- ${item}`)] : [],
    "",
    criteriaList(node.done),
    TRANSITION_CONTRACT,
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}

export function rosterPrompt(visible: readonly Workflow[]): string {
  if (!visible.length) return "";
  return [
    "# Available workflows",
    "Start a listed workflow with the `workflow_start` tool only when the user asks. The user can also start one with its slash command (`/name target`).",
    ...visible.map((workflow) => `- \`${workflow.name}\`: ${workflow.description}`),
  ].join("\n");
}

export function controlMessage(state: Execution): string {
  const position = state.status === "active" ? state.stack[state.stack.length - 1] : undefined;
  const where = position ? position.key : "completion";
  return `${controlPrefix(state.runId)} at ${where}.`;
}

export function controlPrefix(runId: string): string {
  return `Continue workflow \`${runId}\``;
}

export function summaryPrefix(runId: string): string {
  return `Summarize completed workflow \`${runId}\``;
}

export function summaryMessage(workflow: Workflow, state: Execution): string {
  return [
    `${summaryPrefix(state.runId)}: ${workflow.title} run \`${state.runId}\` is complete.`,
    "Summarize what was done, the key findings and recommendations, the risks or open issues, and suggested next steps.",
  ].join("\n");
}
