import { currentPosition } from "../engine/interpreter.ts";
import type { Checkpoint } from "../domain/checkpoint.ts";
import type { Execution, ForEachFrame, RepeatFrame } from "../domain/execution.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import type { Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { lastSegment } from "../domain/keys.ts";
import type { NodeResult } from "../planning/schema.ts";

type ReadBlock = (path: string, label: string) => string;

export function readBlockFrom(fs: { readFileSync(path: string, encoding: "utf8"): string }): ReadBlock {
  return (path: string, label: string): string => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `${label} unavailable: ${detail}. Restore the file or abort the run.`;
    }
  };
}

function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

function readBody(read: ReadBlock, path: string, label: string): string {
  return stripFrontmatter(read(path, label)).trim();
}

const TRANSITION_CONTRACT = [
  "## Transition contract",
  "Conclude the current position with exactly one `workflow_transition` call.",
  "- `status`: `completed` when the criteria are met, `needs-work` when the output has problems, or `blocked` when you cannot proceed.",
  "- `met`: the required criterion IDs below that are complete. Only valid with `status: \"completed\"`; a completion must list every required criterion.",
  "- `checkpoint`: an object with a required `summary` and optional `evidence`, `decisions`, `unknowns`, and `data` fields.",
  "- `issues`: problems found, each `{ target, reason }`. Only valid with `status: \"needs-work\"`; recovery policy decides what happens next.",
  "Invalid transitions return errors without changing the run.",
].join("\n");

function loopContext(workflow: Workflow, state: Execution): string {
  const lines: string[] = [];
  for (const frame of state.stack) {
    if (frame.kind === "foreach") {
      const of: ForEachFrame = frame;
      const current = of.items[of.index];
      lines.push(`Iteration ${of.index + 1}/${of.items.length}`, `${of.variable} = ${JSON.stringify(current ?? null)}`);
    } else if (frame.kind === "repeat") {
      const of: RepeatFrame = frame;
      const block = blockOf(workflow, of.blockId);
      const total = block?.kind === "repeat" ? `/${block.max}` : "";
      lines.push(`Attempt ${of.iteration + 1}${total}`);
    }
  }
  return lines.length ? ["## Loop context", ...lines].join("\n") : "";
}

function priorCheckpoints(workflow: Workflow, state: Execution, beforeKey: string): string {
  const entries = Object.entries(state.checkpoints).filter(([key]) => key < beforeKey && !key.startsWith(beforeKey));
  if (entries.length === 0) return "";
  const lines = entries.slice(-8).map(([key, checkpoint]: [string, Checkpoint]) => `- \`${lastSegment(key)}\`: ${checkpoint.summary}`);
  return lines.length ? ["## Prior checkpoints", ...lines].join("\n") : "";
}

function criteriaList(done: readonly string[] | undefined): string {
  if (!done || done.length === 0) return "Required criteria: none";
  return ["Required criteria:", ...done.map((id) => `- \`${id}\``)].join("\n");
}

function operatorRoster(workflow: Workflow, allowed: readonly string[]): string {
  const lines = allowed
    .map((id) => workflow.operators.get(id))
    .filter((operator): operator is NonNullable<typeof operator> => Boolean(operator))
    .map((operator) => `- \`${operator.id}\`: ${operator.description}`);
  return ["## Operator registry", ...lines].join("\n");
}

const PLAN_SCHEMA_SECTION = [
  "## Plan schema",
  "On completion, `checkpoint.data.plan` must be a JSON object:",
  '`{ "version": 1, "nodes": [ { "id", "operator", "objective", "dependsOn"?, "evidence"?, "done" } ] }`',
  `- 2 to ${LIMITS.planNodes} nodes; unique ids matching ${ID_PATTERN}; each operator must appear in the registry above.`,
  "- `dependsOn` names only earlier nodes in declaration order or retained completed node ids.",
  "- `done` lists 1 to 8 criterion ids for this node's completion.",
  `- Unknown keys and plans above ${LIMITS.planBytes / 1024} KiB are rejected.`,
].join("\n");

function retainedResults(execution: { plan: { nodes: readonly { id: string; operator: string }[] }; results: Readonly<Record<string, NodeResult>> }): string {
  const lines = execution.plan.nodes
    .filter((node) => execution.results[node.id])
    .map((node) => `- \`${node.id}\` [${node.operator}]: ${execution.results[node.id].summary}`);
  return lines.length ? ["## Retained completed results", ...lines].join("\n") : "";
}

export function renderPrompt(workflow: Workflow, state: Execution, read: ReadBlock): string {
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
  const controls = ["## Controls", "- `workflow_transition` - conclude the current position once its criteria are met or problems are found.", "- `workflow_abort` - stop the run when the user asks or it cannot continue."];
  if (position.type === "task") {
    return [
      ...header,
      "",
      ...controls,
      "",
      loopContext(workflow, state),
      "",
      "## Workflow overview",
      "",
      readBody(read, workflow.overviewPath, "Workflow overview"),
      priorCheckpoints(workflow, state, position.key),
      "## Current task instructions",
      "",
      readBody(read, position.task!.instructionPath, "Task instructions"),
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
      "## Task: create a bounded plan",
      "",
      `Compose a plan of ${position.plan!.operators.length === 1 ? "2 to 8" : "2 to 8"} nodes using only the trusted operators below.`,
      operatorRoster(workflow, position.plan!.operators),
      PLAN_SCHEMA_SECTION,
    ];
    if (position.execution) {
      sections.push(retainedResults(position.execution));
      sections.push(`Plan revision ${position.execution.revision}; ${position.execution.replans} replans used.`);
    }
    sections.push(TRANSITION_CONTRACT);
    return sections.filter((section) => section !== "").join("\n\n");
  }
  const node = position.node!;
  const operator = workflow.operators.get(node.operator)!;
  const execution = position.execution!;
  const dependencies = (node.dependsOn ?? [])
    .map((dependency) => execution.results[dependency])
    .filter((result): result is NodeResult => Boolean(result))
    .map((result) => `- \`${result.id}\`: ${result.summary}`);
  const unknowns = execution.plan.nodes
    .map((entry) => execution.results[entry.id]?.unknowns ?? [])
    .flat()
    .slice(0, LIMITS.planNodeListItems);
  const nodeIndex = execution.plan.nodes.findIndex((entry) => entry.id === node.id);
  return [
    ...header,
    `Node ${nodeIndex + 1}/${execution.plan.nodes.length}: \`${node.id}\` (plan revision ${execution.revision})`,
    "",
    ...controls,
    "",
    `## Operator: ${operator.id}`,
    "",
    readBody(read, operator.path, "Operator instructions"),
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
  return `Continue workflow \`${state.runId}\` at ${where}.`;
}

export function summaryMessage(workflow: Workflow, state: Execution): string {
  return [
    `${workflow.title} run \`${state.runId}\` is complete.`,
    "Summarize what was done, the key findings and recommendations, the risks or open issues, and suggested next steps.",
  ].join("\n");
}
