import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Checkpoint, ExecutionState, NodeResult, RunPosition, WorkflowDescriptor, WorkflowMemory, WorkflowStep } from "./types.ts";
import { ID_PATTERN, LIMITS } from "./types.ts";
import { activeSnapshotV3, emptyMemory, latestSnapshot, SNAPSHOT_TYPE, validateCheckpoint, type ActiveSnapshotV3, type TerminalSnapshot } from "./state.ts";
import { firstIncompleteNode, invalidateResults, validateDynamicPlan } from "./plan.ts";

export const START_TOOL_NAME = "workflow_start";
export const ADVANCE_TOOL_NAME = "workflow_advance";
export const TRANSITION_TOOL_NAME = "workflow_transition";
export const ABORT_TOOL_NAME = "workflow_abort";
export const LEGACY_RUN_TOOLS = [ADVANCE_TOOL_NAME, ABORT_TOOL_NAME] as const;
export const STRUCTURED_RUN_TOOLS = [TRANSITION_TOOL_NAME, ABORT_TOOL_NAME] as const;
export const ALL_WORKFLOW_TOOLS = [START_TOOL_NAME, ...LEGACY_RUN_TOOLS, ...STRUCTURED_RUN_TOOLS] as const;

export class WorkflowStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`workflow ${operation} was not committed to session storage: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowStorageError";
  }
}

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("workflow operation cancelled");
}

export interface ActiveRun {
  readonly workflow: WorkflowDescriptor;
  readonly runId: string;
  readonly position: RunPosition;
  readonly target: string;
  readonly memory: WorkflowMemory;
  /** Captured pre-run session model selector; set once when the run first applies a model. */
  restoreModel?: string;
}

type RunState =
  | { readonly status: "idle" }
  | { readonly status: "active"; readonly run: ActiveRun; readonly delivered: boolean };

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function stepIndexOf(workflow: WorkflowDescriptor, stepId: string): number {
  const index = workflow.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`unknown step id: ${stepId}`);
  return index + 1;
}

function currentStepOf(run: ActiveRun): WorkflowStep {
  return run.workflow.steps[stepIndexOf(run.workflow, run.position.stepId) - 1];
}

function plannerStepOf(workflow: WorkflowDescriptor): WorkflowStep | undefined {
  return workflow.steps.find((step) => step.kind === "planner");
}

function executorStepOf(workflow: WorkflowDescriptor): WorkflowStep | undefined {
  return workflow.steps.find((step) => step.kind === "executor");
}

function positionKey(position: RunPosition): string {
  return position.kind === "step" ? `step:${position.stepId}` : `node:${position.stepId}:${position.revision}:${position.nodeId}:${position.attempt}`;
}

function nodeIndexOf(execution: ExecutionState, nodeId: string): number {
  return execution.plan.nodes.findIndex((node) => node.id === nodeId);
}

function displayPosition(run: ActiveRun): string {
  if (run.position.kind === "step") return run.position.stepId;
  const execution = run.memory.execution!;
  const index = nodeIndexOf(execution, run.position.nodeId) + 1;
  return `${run.position.stepId} node ${index}/${execution.plan.nodes.length}: ${run.position.nodeId}`;
}

function statusValue(run: ActiveRun): string {
  const workflow = run.workflow;
  if (run.position.kind === "step") {
    const index = stepIndexOf(workflow, run.position.stepId);
    return `${workflow.name} ${index}/${workflow.steps.length}`;
  }
  const execution = run.memory.execution!;
  const index = nodeIndexOf(execution, run.position.nodeId);
  return `${workflow.name} ${run.position.stepId} ${index + 1}/${execution.plan.nodes.length}`;
}

function readBlock(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${label} unavailable: ${detail}. Restore the file or abort the run.`;
  }
}

function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

function readBody(path: string, label: string): string {
  return stripFrontmatter(readBlock(path, label)).trim();
}

export function promptFor(run: ActiveRun): string {
  const stepIndex = stepIndexOf(run.workflow, run.position.stepId);
  const step = run.workflow.steps[stepIndex - 1];
  return [
    "# Active workflow",
    `Workflow: ${run.workflow.title} (\`${run.workflow.name}\`)`,
    `Run: \`${run.runId}\` - Step: ${stepIndex}/${run.workflow.steps.length} (step ${stepIndex} (${step.label}))`,
    "",
    "You are mid-workflow. Treat the instructions below as authoritative.",
    "",
    "## Controls",
    "- `workflow_advance` - advance once the current step's completion criteria are met. The workflow completes after the final step.",
    "- `workflow_abort` - stop the run when the user asks or it cannot continue. To restart, abort then start the workflow again.",
    "",
    "## Workflow overview",
    readBlock(run.workflow.overviewPath, "Workflow overview"),
    "## Current step instructions",
    readBlock(step.path, "Step instructions"),
  ].join("\n\n");
}

export function rosterPrompt(visible: readonly WorkflowDescriptor[]): string {
  if (!visible.length) return "";
  return [
    "# Available workflows",
    "Start a listed workflow with the `workflow_start` tool only when the user asks. The user can also start one with its slash command (`/name target`).",
    ...visible.map((workflow) => `- \`${workflow.name}\`: ${workflow.description}`),
  ].join("\n");
}

function legacyTransitionMessage(run: ActiveRun): string {
  const stepIndex = stepIndexOf(run.workflow, run.position.stepId);
  const start = stepIndex === 1;
  const lines = start
    ? [`Start ${run.workflow.title} run \`${run.runId}\` at step ${stepIndex} (${run.workflow.steps[stepIndex - 1].label}).`, "Follow the workflow overview and step instructions below semantically."]
    : [`Continue ${run.workflow.title} run \`${run.runId}\` at step ${stepIndex} (${run.workflow.steps[stepIndex - 1].label}).`, "Follow the step instructions below semantically."];
  if (start) {
    if (run.target) lines.push(`Target: ${run.target}`);
    lines.push("## Workflow overview", readFileSync(run.workflow.overviewPath, "utf8"));
  }
  lines.push("## Step instructions", readFileSync(run.workflow.steps[stepIndex - 1].path, "utf8"));
  return lines.join("\n\n");
}

function controlMessage(run: ActiveRun): string {
  return `Continue workflow \`${run.runId}\` at ${displayPosition(run)}.`;
}

const TRANSITION_CONTRACT = [
  "## Transition contract",
  "Conclude the current position with exactly one `workflow_transition` call.",
  "- `outcome`: `pass` when the criteria are met, `blocked` when you cannot proceed, `rework` to redo an earlier destination, or `replan` to regenerate the dynamic plan.",
  "- `met`: the required criterion IDs below that are complete. Only valid with `outcome: \"pass\"`; a pass must list every required criterion.",
  "- `checkpoint`: an object with a required `summary` and optional `evidence`, `decisions`, `unknowns`, and `data` fields.",
  "- `nodes`: valid node IDs to invalidate, only for a verifier rework.",
  "Invalid transitions return errors without changing the run.",
].join("\n");

function criteriaList(step: WorkflowStep): string {
  if (!step.done || step.done.length === 0) return "Required criteria: none";
  return ["Required criteria:", ...step.done.map((id) => `- \`${id}\``)].join("\n");
}

function routeFor(workflow: WorkflowDescriptor, step: WorkflowStep, route: "pass" | "rework" | "replan"): string {
  if (route === "pass") {
    if (step.on?.pass) return step.on.pass;
    const index = workflow.steps.indexOf(step);
    return index + 1 < workflow.steps.length ? workflow.steps[index + 1].id : "complete";
  }
  if (route === "rework") return step.on?.rework ?? step.id;
  const planner = plannerStepOf(workflow);
  return step.on?.replan ?? planner?.id ?? "unavailable";
}

function outcomeRoutes(workflow: WorkflowDescriptor, step: WorkflowStep): string {
  return [
    `Outcomes: \`pass\` -> ${routeFor(workflow, step, "pass")}, \`blocked\` -> stays at ${step.id}, \`rework\` -> ${routeFor(workflow, step, "rework")}, \`replan\` -> ${routeFor(workflow, step, "replan")}.`,
  ].join("\n");
}

function checkpointSummaries(memory: WorkflowMemory, beforeIndex: number, workflow: WorkflowDescriptor, excludeStepId?: string): string {
  const lines: string[] = [];
  for (const step of workflow.steps.slice(0, Math.max(0, beforeIndex))) {
    if (step.id === excludeStepId) continue;
    const checkpoint = memory.steps[step.id];
    if (checkpoint) lines.push(`- \`${step.id}\`: ${checkpoint.summary}`);
  }
  return lines.length ? ["## Prior step checkpoints", ...lines].join("\n") : "";
}

function stepBodySection(step: WorkflowStep): string {
  return ["## Current step instructions", "", `# ${step.id}`, "", readBody(step.path, "Step instructions")].join("\n");
}

function operatorRosterSection(workflow: WorkflowDescriptor): string {
  if (workflow.operators.size === 0) return "";
  return [
    "## Operator registry",
    ...[...workflow.operators.values()].map((operator) => `- \`${operator.id}\`: ${operator.description}`),
  ].join("\n");
}

const PLAN_SCHEMA_SECTION = [
  "## Plan schema",
  "On pass, `checkpoint.data.plan` must be a JSON object:",
  '`{ "version": 1, "nodes": [ { "id", "operator", "objective", "dependsOn"?, "evidence"?, "done", "tools"? } ] }`',
  `- 2 to ${LIMITS.planNodes} nodes; unique ids matching ${ID_PATTERN}; a known operator per node.`,
  "- `dependsOn` names only earlier nodes in declaration order or retained completed node ids.",
  "- `done` lists 1 to 8 criterion ids for this node's pass.",
  "- `tools` names baseline tools only; ceilings apply.",
  `- Rejects unknown keys, prompt-like fields, and plans above ${LIMITS.planBytes / 1024} KiB.`,
].join("\n");

function retainedResultsSection(execution: ExecutionState): string {
  const lines = execution.plan.nodes
    .filter((node) => execution.results[node.id])
    .map((node) => `- \`${node.id}\` [${node.operator}]: ${execution.results[node.id].summary}`);
  return lines.length ? ["## Retained completed results", ...lines].join("\n") : "";
}

function replanReasonSection(memory: WorkflowMemory, executorStepId: string | undefined): string {
  if (!executorStepId) return "";
  const checkpoint = memory.steps[executorStepId];
  if (!checkpoint) return "";
  return ["## Replan reason", "", checkpoint.summary, ...(checkpoint.unknowns ?? []).map((item) => `- unknown: ${item}`)].join("\n");
}

function verifierSection(run: ActiveRun, step: WorkflowStep): string {
  const execution = run.memory.execution;
  const executor = executorStepOf(run.workflow);
  if (!execution || !executor || (step.on?.rework ?? step.id) !== executor.id) return "";
  const completed = execution.plan.nodes.filter((node) => execution.results[node.id]);
  if (completed.length === 0) return "";
  return [
    `## Active plan results (revision ${execution.revision})`,
    ...completed.map((node) => `- \`${node.id}\` [${node.operator}]: ${execution.results[node.id].summary}`),
    "",
    "Rework may invalidate completed nodes by id via `nodes`; their dependents are invalidated too:",
    ...completed.map((node) => `- \`${node.id}\``),
  ].join("\n");
}

function structuredStepPrompt(run: ActiveRun): string {
  const workflow = run.workflow;
  const step = currentStepOf(run);
  const index = workflow.steps.indexOf(step);
  const sections = [
    "# Active workflow",
    `Workflow: ${workflow.title} (\`${workflow.name}\`) - ${workflow.description}`,
    `Run: \`${run.runId}\``,
    run.target ? `Target: ${run.target}` : "",
    `Position: ${index + 1}/${workflow.steps.length} at \`${step.id}\` (${step.kind})`,
    "",
    "You are mid-workflow. Treat the instructions below as authoritative; earlier instructions are superseded.",
    "",
    outcomeRoutes(workflow, step),
    "",
    "## Workflow overview",
    "",
    readBody(workflow.overviewPath, "Workflow overview"),
    checkpointSummaries(run.memory, index, workflow),
    verifierSection(run, step),
    stepBodySection(step),
    criteriaList(step),
    TRANSITION_CONTRACT,
  ];
  if (step.kind === "planner") {
    sections.push(operatorRosterSection(workflow), PLAN_SCHEMA_SECTION);
    if (run.memory.execution) {
      sections.push(retainedResultsSection(run.memory.execution), replanReasonSection(run.memory, executorStepOf(workflow)?.id));
    }
  }
  return sections.filter((section) => section !== "").join("\n\n");
}

function nodePrompt(run: ActiveRun): string {
  const workflow = run.workflow;
  const position = run.position as Extract<RunPosition, { kind: "node" }>;
  const execution = run.memory.execution!;
  const node = execution.plan.nodes.find((item) => item.id === position.nodeId)!;
  const operator = workflow.operators.get(node.operator)!;
  const dependencyResults = (node.dependsOn ?? [])
    .map((dependency) => execution.results[dependency])
    .filter((result): result is NodeResult => Boolean(result))
    .map((result) => `- \`${result.id}\`: ${result.summary}`);
  const unknowns = execution.plan.nodes
    .map((item) => execution.results[item.id]?.unknowns ?? [])
    .flat()
    .slice(0, LIMITS.planNodeListItems);
  const sections = [
    "# Active workflow",
    `Workflow: ${workflow.title} (\`${workflow.name}\`)`,
    `Run: \`${run.runId}\` - node \`${node.id}\` (${nodeIndexOf(execution, node.id) + 1}/${execution.plan.nodes.length})`,
    run.target ? `Target: ${run.target}` : "",
    `Attempt ${position.attempt}/${LIMITS.nodeAttempts}, plan revision ${position.revision}.`,
    "",
    `## Operator: ${operator.id}`,
    "",
    readBody(operator.path, "Operator instructions"),
    dependencyResults.length ? ["## Dependency results", ...dependencyResults].join("\n") : "",
    unknowns.length ? ["## Open unknowns", ...unknowns.map((item) => `- ${item}`)].join("\n") : "",
    "## Node objective",
    "",
    node.objective,
    ...(node.evidence ?? []).length ? ["", "Expected evidence:", ...(node.evidence ?? []).map((item) => `- ${item}`)] : [],
    "",
    ["Required criteria:", ...node.done.map((id) => `- \`${id}\``)].join("\n"),
    TRANSITION_CONTRACT,
  ];
  return sections.filter((section) => section !== "").join("\n\n");
}

function structuredPrompt(run: ActiveRun): string {
  return run.position.kind === "node" ? nodePrompt(run) : structuredStepPrompt(run);
}

function summaryMessage(run: ActiveRun): string {
  return [
    `${run.workflow.title} run \`${run.runId}\` is complete: all ${run.workflow.steps.length} steps advanced.`,
    "Summarize what was done, the key findings and recommendations, the risks or open issues, and suggested next steps.",
  ].join("\n");
}

function snapshotOf(run: ActiveRun, delivered: boolean): ActiveSnapshotV3 {
  return activeSnapshotV3({
    workflow: run.workflow.name,
    runId: run.runId,
    position: run.position,
    target: run.target,
    delivered,
    memory: run.memory,
    ...(run.restoreModel !== undefined ? { restoreModel: run.restoreModel } : {}),
  });
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}

export interface TransitionRequest {
  readonly outcome: "pass" | "blocked" | "rework" | "replan";
  readonly met: readonly string[];
  readonly checkpoint: Checkpoint;
  readonly nodes?: readonly string[];
}

export function parseTransitionRequest(params: unknown): TransitionRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("transition must be an object");
  const raw = params as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["outcome", "met", "checkpoint", "nodes"].includes(key)) throw new Error(`unknown transition field: ${key}`);
  }
  if (raw.outcome !== "pass" && raw.outcome !== "blocked" && raw.outcome !== "rework" && raw.outcome !== "replan") {
    throw new Error("outcome must be pass, blocked, rework, or replan");
  }
  if (raw.met !== undefined && !Array.isArray(raw.met)) throw new Error("met must be a list of criterion ids");
  const met = (raw.met ?? []).map((value, index) => {
    const id = typeof value === "string" ? value : "";
    if (!ID_PATTERN.test(id)) throw new Error(`met[${index}] must match ${ID_PATTERN}`);
    return id;
  });
  if (new Set(met).size !== met.length) throw new Error("met must not contain duplicates");
  if (raw.checkpoint === undefined) throw new Error("checkpoint is required");
  const checkpoint = validateCheckpoint(raw.checkpoint, "checkpoint");
  let nodes: string[] | undefined;
  if (raw.nodes !== undefined) {
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error("nodes must be a non-empty list of node ids");
    nodes = raw.nodes.map((value, index) => {
      const id = typeof value === "string" ? value : "";
      if (!ID_PATTERN.test(id)) throw new Error(`nodes[${index}] must match ${ID_PATTERN}`);
      return id;
    });
    if (new Set(nodes).size !== nodes.length) throw new Error("nodes must not contain duplicates");
  }
  return { outcome: raw.outcome, met, checkpoint, ...(nodes ? { nodes } : {}) };
}

/** Session-scoped workflow state machine, decoupled from tool registration. */
export class WorkflowRuntime {
  readonly workflows: readonly WorkflowDescriptor[];
  readonly visibleWorkflows: readonly WorkflowDescriptor[];
  private readonly pi: { getActiveTools(): string[]; setActiveTools(names: string[]): void; appendEntry(type: string, data: unknown): void; sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }): void };
  private state: RunState = { status: "idle" };
  private baselineTools: string[] | null = null;
  private sentDelivery: { runId: string; key: string } | null = null;

  constructor(pi: WorkflowRuntime["pi"], workflows: readonly WorkflowDescriptor[]) {
    this.pi = pi;
    this.workflows = workflows;
    this.visibleWorkflows = workflows.filter((workflow) => workflow.piVisibility);
  }

  private readonly isWorkflowTool = (name: string): boolean => (ALL_WORKFLOW_TOOLS as readonly string[]).includes(name);
  private readonly captureBaseline = (): string[] => this.pi.getActiveTools().filter((name) => !this.isWorkflowTool(name));

  private activeToolsFor(run: ActiveRun | undefined): string[] {
    this.baselineTools ??= this.captureBaseline();
    let base = [...this.baselineTools];
    if (!run) return this.visibleWorkflows.length ? [...base, START_TOOL_NAME] : [...base];
    const step = run.workflow.steps[stepIndexOf(run.workflow, run.position.stepId) - 1];
    let operatorTools: ReadonlySet<string> | undefined;
    let nodeTools: ReadonlySet<string> | undefined;
    const position = run.position;
    if (position.kind === "node") {
      const node = run.memory.execution!.plan.nodes.find((item) => item.id === position.nodeId);
      operatorTools = run.workflow.operators.get(node!.operator)?.tools;
      nodeTools = node?.tools ? new Set(node.tools) : undefined;
    }
    for (const ceiling of [run.workflow.tools, step?.tools, operatorTools, nodeTools]) {
      if (ceiling) base = base.filter((name) => ceiling.has(name));
    }
    const control = run.workflow.structured ? STRUCTURED_RUN_TOOLS : LEGACY_RUN_TOOLS;
    return [...base, ...control];
  }

  private setRunTools(): void {
    this.pi.setActiveTools(this.activeToolsFor(this.state.status === "active" ? this.state.run : undefined));
  }

  private setIdleTools(): void {
    this.pi.setActiveTools(this.activeToolsFor(undefined));
  }

  private showStatus(ctx: ExtensionContext): void {
    const run = this.state.status === "active" ? this.state.run : null;
    ctx.ui.setStatus("pi-workflows", run ? statusValue(run) : undefined);
  }

  private requireActiveState(): Extract<RunState, { status: "active" }> {
    if (this.state.status !== "active") throw new Error("no active workflow");
    return this.state;
  }

  private appendCommitted(snapshot: ActiveSnapshotV3 | TerminalSnapshot, operation: string): void {
    try {
      this.pi.appendEntry(SNAPSHOT_TYPE, snapshot);
    } catch (cause) {
      throw new WorkflowStorageError(operation, cause);
    }
  }

  private selectorFor(run: ActiveRun): string | undefined {
    const step = run.workflow.steps[stepIndexOf(run.workflow, run.position.stepId) - 1];
    return step.model ?? run.workflow.model;
  }

  private captureRestoreModel(run: ActiveRun, ctx: ExtensionContext): void {
    if (run.restoreModel !== undefined) return;
    const current = (ctx as { model?: { provider?: string; id?: string } }).model;
    if (current?.provider && current?.id) run.restoreModel = `${current.provider}/${current.id}`;
  }

  /** Apply the configured model for the run's current position; degrade with a warning when unavailable. */
  private async applyModelFor(run: ActiveRun, ctx: ExtensionContext): Promise<void> {
    if (!run.workflow.structured) return;
    const selector = this.selectorFor(run);
    if (selector === undefined) return;
    const registry = (ctx as { modelRegistry?: { find(provider: string, modelId: string): unknown } }).modelRegistry;
    if (!registry || typeof registry.find !== "function") return;
    const [provider, modelId] = selector.split("/");
    const model = registry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`Configured model ${selector} is unavailable; keeping the current model.`, "warning");
      return;
    }
    this.captureRestoreModel(run, ctx);
    const setModel = (ctx as { setModel?: (model: unknown) => Promise<boolean> }).setModel;
    if (!setModel) return;
    let applied = false;
    try {
      applied = await setModel(model);
    } catch {
      applied = false;
    }
    if (!applied) ctx.ui.notify(`Could not switch to model ${selector}; keeping the current model.`, "warning");
  }

  private async restoreSessionModel(run: ActiveRun, ctx: ExtensionContext): Promise<void> {
    if (run.restoreModel === undefined) return;
    const registry = (ctx as { modelRegistry?: { find(provider: string, modelId: string): unknown } }).modelRegistry;
    const setModel = (ctx as { setModel?: (model: unknown) => Promise<boolean> }).setModel;
    if (!registry || typeof registry.find !== "function" || !setModel) return;
    const [provider, modelId] = run.restoreModel.split("/");
    const model = registry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`Cannot restore session model ${run.restoreModel}; keeping the current model.`, "warning");
      return;
    }
    let restored = false;
    try {
      restored = await setModel(model);
    } catch {
      restored = false;
    }
    if (!restored) ctx.ui.notify(`Could not restore session model ${run.restoreModel}; keeping the current model.`, "warning");
  }

  private async deliverPending(ctx: ExtensionContext): Promise<void> {
    if (this.state.status !== "active" || this.state.delivered) return;
    const pending = this.state;
    const delivery = { runId: pending.run.runId, key: positionKey(pending.run.position) };
    if (this.sentDelivery?.runId !== delivery.runId || this.sentDelivery.key !== delivery.key) {
      if (pending.run.workflow.structured && this.selectorFor(pending.run) !== undefined) {
        await this.applyModelFor(pending.run, ctx);
      }
      let message: string;
      if (pending.run.workflow.structured) {
        message = controlMessage(pending.run);
      } else {
        try {
          message = legacyTransitionMessage(pending.run);
        } catch (error) {
          ctx.ui.notify(`Workflow content unreadable: ${error instanceof Error ? error.message : String(error)}. Restore the file to retry delivery, or abort the run.`, "error");
          return;
        }
      }
      try {
        await this.pi.sendUserMessage(message, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Workflow follow-up failed: ${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`, "error");
        return;
      }
      this.sentDelivery = delivery;
    }
    if (this.state !== pending) return;
    try {
      this.appendCommitted(snapshotOf(pending.run, true), `delivered marker for ${pending.run.workflow.title} run ${pending.run.runId}`);
    } catch (error) {
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`, "error");
      return;
    }
    if (this.state === pending) this.state = { ...pending, delivered: true };
  }

  private restoreRun(ctx: ExtensionContext): void {
    const snapshot = latestSnapshot(ctx.sessionManager.getBranch());
    if (!snapshot) return;
    if (snapshot.status === "invalid") {
      ctx.ui.notify(`Dropped active workflow run: malformed snapshot (${snapshot.error}). Start the workflow again.`, "warning");
      return;
    }
    if (snapshot.status !== "active") return;
    const workflow = this.workflows.find((item) => item.name === snapshot.workflow);
    if (!workflow) {
      ctx.ui.notify(`Cannot resume ${snapshot.workflow} run: that workflow no longer exists.`, "warning");
      return;
    }
    if (snapshot.v === 2) {
      if (snapshot.step > workflow.steps.length) {
        ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.runId}\`: step ${snapshot.step} of ${workflow.steps.length} no longer exists.`, "warning");
        return;
      }
      const run: ActiveRun = { workflow, runId: snapshot.runId, position: { kind: "step", stepId: workflow.steps[snapshot.step - 1].id }, target: snapshot.target, memory: emptyMemory() };
      this.adoptRestoredRun(run, snapshot.delivered, ctx);
      return;
    }
    let position: RunPosition = snapshot.position;
    try {
      stepIndexOf(workflow, position.stepId);
    } catch {
      ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.runId}\`: step \`${position.stepId}\` no longer exists.`, "warning");
      return;
    }
    if (position.kind === "node") {
      const execution = snapshot.memory.execution;
      const nodeId = position.nodeId;
      if (!execution || !execution.plan.nodes.some((node) => node.id === nodeId) || execution.revision !== position.revision) {
        ctx.ui.notify(`Cannot resume ${workflow.title} run \`${snapshot.runId}\`: node \`${nodeId}\` is not in the active plan revision. Replan from the planner step.`, "warning");
        return;
      }
    }
    const run: ActiveRun = { workflow, runId: snapshot.runId, position, target: snapshot.target, memory: snapshot.memory, ...(snapshot.restoreModel !== undefined ? { restoreModel: snapshot.restoreModel } : {}) };
    this.adoptRestoredRun(run, snapshot.delivered, ctx);
  }

  private adoptRestoredRun(run: ActiveRun, delivered: boolean, ctx: ExtensionContext): void {
    this.state = { status: "active", run, delivered };
    this.setRunTools();
    this.showStatus(ctx);
    ctx.ui.notify(`Resumed ${run.workflow.title} run \`${run.runId}\` at ${displayPosition(run)}.`, "info");
    void this.applyModelFor(run, ctx);
  }

  async startWorkflow(ctx: ExtensionContext, workflow: WorkflowDescriptor, target: string, signal?: AbortSignal): Promise<ActiveRun | null> {
    if (this.state.status === "active") {
      ctx.ui.notify(`${this.state.run.workflow.title} run ${this.state.run.runId} is already active.`, "error");
      return null;
    }
    assertNotCancelled(signal);
    const run: ActiveRun = { workflow, runId: newRunId(), position: { kind: "step", stepId: workflow.steps[0].id }, target: target.trim(), memory: emptyMemory() };
    this.appendCommitted(snapshotOf(run, false), `start of ${workflow.title} run ${run.runId}`);
    this.state = { status: "active", run, delivered: false };
    this.setRunTools();
    this.showStatus(ctx);
    ctx.ui.notify(`${workflow.title} started.`, "info");
    await this.deliverPending(ctx);
    return run;
  }

  private enterStepPosition(memory: WorkflowMemory, stepId: string): RunPosition {
    if (this.state.status !== "active") throw new Error("no active workflow");
    const workflow = this.state.run.workflow;
    const step = workflow.steps[stepIndexOf(workflow, stepId) - 1];
    if (step.kind === "executor") {
      const execution = memory.execution;
      if (!execution) throw new Error(`entering the executor step \`${stepId}\` requires a generated plan; pass the planner step first`);
      const node = firstIncompleteNode(execution);
      if (!node) throw new Error(`the active plan has no incomplete nodes; verify or replan instead of re-entering \`${stepId}\``);
      return { kind: "node", stepId, revision: execution.revision, nodeId: node.id, attempt: 1 };
    }
    return { kind: "step", stepId };
  }

  private async completeRun(current: Extract<RunState, { status: "active" }>, ctx: ExtensionContext, viaLegacyAdvance: boolean): Promise<ToolResult> {
    const { workflow, runId } = current.run;
    try {
      this.appendCommitted({ v: 2, status: "completed", workflow: workflow.name, runId, totalSteps: workflow.steps.length }, `completion of ${workflow.title} run ${runId}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays active at ${displayPosition(current.run)}.` }],
        details: { workflow: workflow.name, runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "idle" };
    this.setIdleTools();
    this.showStatus(ctx);
    await this.restoreSessionModel(current.run, ctx);
    if (viaLegacyAdvance) {
      try {
        await this.pi.sendUserMessage(summaryMessage(current.run), { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Workflow summary request failed: ${error instanceof Error ? error.message : String(error)}.`, "error");
      }
      return {
        content: [{ type: "text", text: `${workflow.title} run ${runId} completed. A summary request arrives in the next message.` }],
        details: { workflow: workflow.name, runId, status: "completed" },
        terminate: true,
      };
    }
    return {
      content: [{ type: "text", text: `${workflow.title} run ${runId} completed. Present the prepared final result in your reply; no further message will arrive.` }],
      details: { workflow: workflow.name, runId, status: "completed" },
    };
  }

  async advance(signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    const current = this.requireActiveState();
    if (current.run.workflow.structured) {
      return {
        content: [{ type: "text", text: "This workflow uses `workflow_transition` for structured steps." }],
        details: { workflow: current.run.workflow.name, status: "wrong-tool" },
        isError: true,
      };
    }
    assertNotCancelled(signal);
    if (!current.delivered) {
      return {
        content: [{ type: "text", text: `Cannot advance step \`${current.run.position.stepId}\` before its instructions are delivered.` }],
        details: { workflow: current.run.workflow.name, runId: current.run.runId, status: "delivery-pending" },
        isError: true,
      };
    }
    const { workflow, runId, target, memory } = current.run;
    const index = stepIndexOf(workflow, current.run.position.stepId);
    if (index >= workflow.steps.length) return this.completeRun(current, ctx, true);
    const run: ActiveRun = { workflow, runId, target, memory, position: { kind: "step", stepId: workflow.steps[index].id } };
    try {
      this.appendCommitted(snapshotOf(run, false), `advance of ${workflow.title} run ${runId} to step ${index + 1}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays active at step ${index}.` }],
        details: { workflow: workflow.name, runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "active", run, delivered: false };
    this.showStatus(ctx);
    this.setRunTools();
    await this.deliverPending(ctx);
    return {
      content: [{ type: "text", text: `Step \`${current.run.position.stepId}\` complete. Advancing to \`${run.position.stepId}\`. Its instructions arrive in the next message.` }],
      details: { workflow: workflow.name, runId, step: run.position.stepId, status: "active" },
      terminate: true,
    };
  }

  async transition(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    const current = this.requireActiveState();
    if (!current.run.workflow.structured) {
      return {
        content: [{ type: "text", text: "This workflow uses `workflow_advance` to move between steps." }],
        details: { workflow: current.run.workflow.name, status: "wrong-tool" },
        isError: true,
      };
    }
    assertNotCancelled(signal);
    if (!current.delivered) {
      return {
        content: [{ type: "text", text: `Cannot transition \`${displayPosition(current.run)}\` before its instructions are delivered.` }],
        details: { workflow: current.run.workflow.name, runId: current.run.runId, status: "delivery-pending" },
        isError: true,
      };
    }
    let request: TransitionRequest;
    try {
      request = parseTransitionRequest(params);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Invalid transition: ${error instanceof Error ? error.message : String(error)}.` }],
        details: { workflow: current.run.workflow.name, runId: current.run.runId, status: "invalid-request" },
        isError: true,
      };
    }
    const resolution = this.resolveTransition(current, request);
    if ("error" in resolution) {
      return {
        content: [{ type: "text", text: `Invalid transition: ${resolution.error}.` }],
        details: { workflow: current.run.workflow.name, runId: current.run.runId, status: "invalid-transition" },
        isError: true,
      };
    }
    if ("complete" in resolution) return this.completeRun(current, ctx, false);
    if ("blocked" in resolution) {
      const run = resolution.blocked;
      try {
        this.appendCommitted(snapshotOf(run, true), `blocked checkpoint of ${current.run.workflow.title} run ${current.run.runId} at ${displayPosition(run)}`);
      } catch (error) {
        if (!(error instanceof WorkflowStorageError)) throw error;
        return {
          content: [{ type: "text", text: `${error.message}. The checkpoint was not recorded.` }],
          details: { workflow: current.run.workflow.name, runId: current.run.runId, status: "storage-failed" },
          isError: true,
        };
      }
      this.state = { status: "active", run, delivered: true };
      this.setRunTools();
      return {
        content: [{ type: "text", text: `Blocked at ${displayPosition(run)}. The checkpoint is saved; ask the user to resolve the blocker, then retry.` }],
        details: { workflow: run.workflow.name, runId: run.runId, position: displayPosition(run), status: "blocked" },
      };
    }
    const run: ActiveRun = resolution.run;
    try {
      this.appendCommitted(snapshotOf(run, false), `transition of ${current.run.workflow.title} run ${current.run.runId} to ${displayPosition(run)}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays at ${displayPosition(current.run)}.` }],
        details: { workflow: current.run.workflow.name, runId: current.run.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "active", run, delivered: false };
    this.showStatus(ctx);
    this.setRunTools();
    await this.deliverPending(ctx);
    return {
      content: [{ type: "text", text: `Recorded ${request.outcome}. Continue at ${displayPosition(run)}; instructions arrive in the next message.` }],
      details: { workflow: run.workflow.name, runId: run.runId, position: displayPosition(run), status: "active" },
    };
  }

  private resolveTransition(
    current: Extract<RunState, { status: "active" }>,
    request: TransitionRequest,
  ): { run: ActiveRun } | { blocked: ActiveRun } | { complete: true } | { error: string } {
    const run = current.run;
    const workflow = run.workflow;
    const checkpointInto = (memory: WorkflowMemory, stepId: string): WorkflowMemory => ({ ...memory, steps: { ...memory.steps, [stepId]: request.checkpoint } });
    if (run.position.kind === "node") {
      return this.resolveNodeTransition(current, request, checkpointInto);
    }
    const step = currentStepOf(run);
    const index = workflow.steps.indexOf(step);
    const criteria = step.done ?? [];
    if (request.outcome !== "pass" && request.met.length > 0) return { error: "met is only valid with outcome \"pass\"" };
    if (request.outcome === "pass") {
      const known = new Set(criteria);
      for (const id of request.met) {
        if (!known.has(id)) return { error: `unknown criterion id: ${id}` };
      }
      for (const id of criteria) {
        if (!request.met.includes(id)) return { error: `pass must list every required criterion; missing: ${id}` };
      }
    }
    if (step.kind === "planner" && request.outcome === "pass") {
      return this.resolvePlannerPass(current, request, checkpointInto);
    }
    if (step.kind === "planner" && request.outcome === "replan") return { error: "the planner step cannot replan; pass a new plan or stay blocked" };
    const executor = executorStepOf(workflow);
    switch (request.outcome) {
      case "pass": {
        const target = step.on?.pass ?? (index + 1 < workflow.steps.length ? workflow.steps[index + 1].id : undefined);
        if (!target) return { complete: true };
        const memory = checkpointInto(run.memory, step.id);
        let position: RunPosition;
        try {
          position = this.enterStepPosition(memory, target);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        return { run: { ...run, memory, position } };
      }
      case "blocked": {
        return { blocked: { ...run, memory: checkpointInto(run.memory, step.id) } };
      }
      case "rework": {
        const target = step.on?.rework ?? step.id;
        const memory = checkpointInto(run.memory, step.id);
        if (request.nodes !== undefined) {
          if (!executor || target !== executor.id) {
            return { error: "nodes is only valid for a verifier rework whose destination is the executor step" };
          }
          const execution = memory.execution;
          if (!execution) return { error: "verifier rework requires an active plan" };
          for (const id of request.nodes) {
            if (!execution.plan.nodes.some((node) => node.id === id)) return { error: `unknown node id: ${id}` };
            if (execution.results[id] === undefined) return { error: `node \`${id}\` has no completed result to invalidate` };
          }
          const invalidation = invalidateResults(execution, request.nodes);
          const earliest = invalidation.removed[0];
          if (earliest === undefined) return { error: "invalidation removed no results" };
          return {
            run: {
              ...run,
              memory: { ...memory, execution: invalidation.execution },
              position: { kind: "node", stepId: executor.id, revision: invalidation.execution.revision, nodeId: earliest, attempt: 1 },
            },
          };
        }
        let position: RunPosition;
        try {
          position = this.enterStepPosition(memory, target);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        return { run: { ...run, memory, position } };
      }
      case "replan": {
        const target = step.on?.replan ?? plannerStepOf(workflow)?.id;
        if (!target) return { error: "replan requires a planner step or an on.replan destination" };
        const memory = checkpointInto(run.memory, step.id);
        const execution = memory.execution;
        if (execution) {
          if (execution.replans + 1 > LIMITS.replans) return { error: `replan limit reached (${LIMITS.replans}); complete the remaining work or abort` };
          return {
            run: {
              ...run,
              memory: { ...memory, execution: { ...execution, revision: execution.revision + 1, replans: execution.replans + 1 } },
              position: { kind: "step", stepId: target },
            },
          };
        }
        return { run: { ...run, memory, position: { kind: "step", stepId: target } } };
      }
    }
  }

  private resolvePlannerPass(
    current: Extract<RunState, { status: "active" }>,
    request: TransitionRequest,
    checkpointInto: (memory: WorkflowMemory, stepId: string) => WorkflowMemory,
  ): { run: ActiveRun } | { error: string } {
    const run = current.run;
    const workflow = run.workflow;
    const plannerStep = currentStepOf(run);
    const planValue = (request.checkpoint.data as { plan?: unknown } | undefined)?.plan;
    if (planValue === undefined) return { error: "a planner pass must carry checkpoint.data.plan" };
    const previous = run.memory.execution;
    const baseline = new Set(this.baselineTools ?? []);
    const validation = validateDynamicPlan(planValue, {
      operators: workflow.operators,
      baselineTools: baseline,
      workflowTools: workflow.tools,
      stepTools: executorStepOf(workflow)?.tools,
      retainedResultIds: new Set(Object.keys(previous?.results ?? {})),
    });
    if ("errors" in validation) return { error: `invalid plan: ${validation.errors.join("; ")}` };
    const plan = validation.plan;
    const executor = executorStepOf(workflow)!;
    const execution: ExecutionState = {
      plan,
      revision: previous ? previous.revision : 1,
      replans: previous ? previous.replans : 0,
      results: previous ? previous.results : {},
    };
    const memory: WorkflowMemory = { ...checkpointInto(run.memory, plannerStep.id), execution };
    const node = firstIncompleteNode(execution)!;
    return { run: { ...run, memory, position: { kind: "node", stepId: executor.id, revision: execution.revision, nodeId: node.id, attempt: 1 } } };
  }

  private resolveNodeTransition(
    current: Extract<RunState, { status: "active" }>,
    request: TransitionRequest,
    checkpointInto: (memory: WorkflowMemory, stepId: string) => WorkflowMemory,
  ): { run: ActiveRun } | { blocked: ActiveRun } | { error: string } {
    const run = current.run;
    const position = run.position as Extract<RunPosition, { kind: "node" }>;
    const workflow = run.workflow;
    const execution = run.memory.execution!;
    const node = execution.plan.nodes.find((item) => item.id === position.nodeId)!;
    if (request.outcome !== "pass" && request.met.length > 0) return { error: "met is only valid with outcome \"pass\"" };
    if (request.nodes !== undefined) return { error: "nodes is only valid for a verifier rework from a static step" };
    const executorId = position.stepId;
    if (request.outcome === "pass") {
      const criteria = node.done;
      const known = new Set(criteria);
      for (const id of request.met) {
        if (!known.has(id)) return { error: `unknown criterion id: ${id}` };
      }
      for (const id of criteria) {
        if (!request.met.includes(id)) return { error: `pass must list every required criterion; missing: ${id}` };
      }
      const result: NodeResult = {
        id: node.id,
        summary: request.checkpoint.summary,
        ...(request.checkpoint.evidence ? { evidence: request.checkpoint.evidence } : {}),
        ...(request.checkpoint.decisions ? { decisions: request.checkpoint.decisions } : {}),
        ...(request.checkpoint.unknowns ? { unknowns: request.checkpoint.unknowns } : {}),
        ...(request.checkpoint.data !== undefined ? { data: request.checkpoint.data } : {}),
      };
      const nextExecution: ExecutionState = { ...execution, results: { ...execution.results, [node.id]: result } };
      const next = firstIncompleteNode(nextExecution);
      if (!next) {
        const executorIndex = workflow.steps.findIndex((step) => step.id === executorId);
        const target = workflow.steps[executorIndex].on?.pass ?? workflow.steps[executorIndex + 1]?.id;
        if (!target) return { error: "the executor step has no following pass destination" };
        let targetPosition: RunPosition;
        try {
          targetPosition = this.enterStepPosition({ ...run.memory, execution: nextExecution }, target);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        return { run: { ...run, memory: { ...run.memory, execution: nextExecution }, position: targetPosition } };
      }
      return {
        run: {
          ...run,
          memory: { ...run.memory, execution: nextExecution },
          position: { kind: "node", stepId: executorId, revision: nextExecution.revision, nodeId: next.id, attempt: 1 },
        },
      };
    }
    if (request.outcome === "rework") {
      if (position.attempt + 1 > LIMITS.nodeAttempts) return { error: `attempt limit reached for node \`${node.id}\` (${LIMITS.nodeAttempts}); replan or block instead` };
      return { run: { ...run, memory: checkpointInto(run.memory, executorId), position: { ...position, attempt: position.attempt + 1 } } };
    }
    if (request.outcome === "replan") {
      if (execution.replans + 1 > LIMITS.replans) return { error: `replan limit reached (${LIMITS.replans}); complete the remaining work or abort` };
      const planner = plannerStepOf(workflow);
      if (!planner) return { error: "replan requires a planner step" };
      return {
        run: {
          ...run,
          memory: {
            ...checkpointInto(run.memory, executorId),
            execution: { ...execution, revision: execution.revision + 1, replans: execution.replans + 1 },
          },
          position: { kind: "step", stepId: planner.id },
        },
      };
    }
    // blocked
    return { blocked: { ...run, memory: checkpointInto(run.memory, executorId) } };
  }

  async abort(signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    const current = this.requireActiveState().run;
    assertNotCancelled(signal);
    try {
      this.appendCommitted({ v: 2, status: "aborted" }, `abort of ${current.workflow.title} run ${current.runId}`);
    } catch (error) {
      if (!(error instanceof WorkflowStorageError)) throw error;
      return {
        content: [{ type: "text", text: `${error.message}. The run stays active.` }],
        details: { workflow: current.workflow.name, runId: current.runId, status: "storage-failed" },
        isError: true,
      };
    }
    this.state = { status: "idle" };
    this.setIdleTools();
    this.showStatus(ctx);
    await this.restoreSessionModel(current, ctx);
    return {
      content: [{ type: "text", text: `${current.workflow.title} run ${current.runId} aborted.` }],
      details: { workflow: current.workflow.name, runId: current.runId, status: "aborted" },
      terminate: true,
    };
  }

  handleSessionStart(ctx: ExtensionContext): { unknownTools: string[]; unknownModels: string[] } {
    this.state = { status: "idle" };
    this.baselineTools = null;
    const available = new Set(this.pi.getActiveTools());
    const unknownTools = this.workflows.flatMap((workflow) => {
      const configured = new Set<string>([
        ...(workflow.tools ?? []),
        ...workflow.steps.flatMap((step) => [...(step.tools ?? [])]),
        ...[...workflow.operators.values()].flatMap((operator) => [...(operator.tools ?? [])]),
      ]);
      return [...configured].filter((tool) => !available.has(tool)).map((tool) => `${workflow.name}: ${tool}`);
    });
    const registry = (ctx as { modelRegistry?: { find(provider: string, modelId: string): unknown } }).modelRegistry;
    const unknownModels: string[] = [];
    if (registry && typeof registry.find === "function") {
      for (const workflow of this.workflows) {
        const selectors = new Set([workflow.model, ...workflow.steps.map((step) => step.model)].filter((selector): selector is string => Boolean(selector)));
        for (const selector of selectors) {
          const [provider, modelId] = selector.split("/");
          if (!registry.find(provider, modelId)) unknownModels.push(`${workflow.name}: ${selector}`);
        }
      }
    }
    this.setIdleTools();
    this.restoreRun(ctx);
    this.showStatus(ctx);
    return { unknownTools, unknownModels };
  }

  async handleAgentSettled(ctx: ExtensionContext): Promise<void> {
    await this.deliverPending(ctx);
  }

  handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (this.state.status === "active") {
      const run = this.state.run;
      const guide = run.workflow.structured ? structuredPrompt(run) : promptFor(run);
      return { systemPrompt: `${event.systemPrompt}\n\n${guide}` };
    }
    const roster = rosterPrompt(this.visibleWorkflows);
    return roster ? { systemPrompt: `${event.systemPrompt}\n\n${roster}` } : undefined;
  }
}
