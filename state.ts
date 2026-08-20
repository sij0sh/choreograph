import { canonicalJsonBytes, jsonDepth, ID_PATTERN, LIMITS, type Checkpoint, type DynamicPlan, type DynamicPlanNode, type ExecutionState, type JsonValue, type NodeResult, type RunPosition, type WorkflowMemory } from "./types.ts";

export const SNAPSHOT_TYPE = "pi-workflows";

export type ActiveSnapshotV2 = {
  readonly v: 2;
  readonly status: "active";
  readonly workflow: string;
  readonly runId: string;
  readonly step: number;
  readonly target: string;
  readonly delivered: boolean;
};

export type ActiveSnapshotV3 = {
  readonly v: 3;
  readonly status: "active";
  readonly workflow: string;
  readonly runId: string;
  readonly position: RunPosition;
  readonly target: string;
  readonly delivered: boolean;
  readonly memory: WorkflowMemory;
  readonly restoreModel?: string;
};

export type TerminalSnapshot =
  | { readonly v: 2; readonly status: "completed"; readonly workflow: string; readonly runId: string; readonly totalSteps: number }
  | { readonly v: 2; readonly status: "aborted" };

export type ParsedSnapshot = ActiveSnapshotV2 | ActiveSnapshotV3 | TerminalSnapshot | { readonly status: "terminal" } | { readonly status: "invalid"; readonly error: string };

export function isStepIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isJsonValue(value: unknown): boolean {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type === "object") return Object.values(value).every(isJsonValue);
  return false;
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boundedStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  if (value.length > LIMITS.checkpointListItems) throw new Error(`${label} must have at most ${LIMITS.checkpointListItems} items`);
  return value.map((item, index) => {
    const text = stringAt(item, `${label}[${index}]`);
    if (Buffer.byteLength(text, "utf8") > LIMITS.checkpointItemBytes) throw new Error(`${label}[${index}] exceeds ${LIMITS.checkpointItemBytes} bytes`);
    return text;
  });
}

function dataAt(value: unknown, label: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) throw new Error(`${label} must be a JSON value`);
  if (jsonDepth(value) > LIMITS.jsonDepth) throw new Error(`${label} nesting must not exceed ${LIMITS.jsonDepth} levels`);
  return value as JsonValue;
}

/** Validate and bound a checkpoint authored by the model. */
export function validateCheckpoint(value: unknown, label: string): Checkpoint {
  const raw = objectAt(value, label);
  for (const key of Object.keys(raw)) {
    if (!["summary", "evidence", "decisions", "unknowns", "data"].includes(key)) throw new Error(`${label}.${key} is not an accepted checkpoint field`);
  }
  const summary = stringAt(raw.summary, `${label}.summary`);
  if (Buffer.byteLength(summary, "utf8") > LIMITS.checkpointSummaryBytes) throw new Error(`${label}.summary exceeds ${LIMITS.checkpointSummaryBytes} bytes`);
  const checkpoint: { summary: string; evidence?: string[]; decisions?: string[]; unknowns?: string[]; data?: JsonValue } = { summary };
  const evidence = boundedStringList(raw.evidence, `${label}.evidence`);
  const decisions = boundedStringList(raw.decisions, `${label}.decisions`);
  const unknowns = boundedStringList(raw.unknowns, `${label}.unknowns`);
  const data = dataAt(raw.data, `${label}.data`);
  if (evidence) checkpoint.evidence = evidence;
  if (decisions) checkpoint.decisions = decisions;
  if (unknowns) checkpoint.unknowns = unknowns;
  if (data !== undefined) checkpoint.data = data;
  if (canonicalJsonBytes(checkpoint as unknown as JsonValue) > LIMITS.checkpointBytes) throw new Error(`${label} exceeds ${LIMITS.checkpointBytes} bytes`);
  return checkpoint;
}

/** Validate and bound a persisted node result. */
export function validateNodeResult(value: unknown, label: string): NodeResult {
  const raw = objectAt(value, label);
  for (const key of Object.keys(raw)) {
    if (!["id", "summary", "evidence", "decisions", "unknowns", "data"].includes(key)) throw new Error(`${label}.${key} is not an accepted result field`);
  }
  const id = stringAt(raw.id, `${label}.id`);
  if (!ID_PATTERN.test(id)) throw new Error(`${label}.id must match ${ID_PATTERN}`);
  const { id: _omitted, ...checkpointFields } = raw;
  const checkpoint = validateCheckpoint(checkpointFields, label);
  const result: NodeResult = { id, summary: checkpoint.summary, ...(checkpoint.evidence ? { evidence: checkpoint.evidence } : {}), ...(checkpoint.decisions ? { decisions: checkpoint.decisions } : {}), ...(checkpoint.unknowns ? { unknowns: checkpoint.unknowns } : {}), ...(checkpoint.data !== undefined ? { data: checkpoint.data } : {}) };
  if (canonicalJsonBytes(result as unknown as JsonValue) > LIMITS.nodeResultBytes) throw new Error(`${label} exceeds ${LIMITS.nodeResultBytes} bytes`);
  return result;
}

function validatePlanNodes(value: unknown, label: string): DynamicPlanNode[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((raw, index) => {
    const node = objectAt(raw, `${label}[${index}]`);
    for (const key of Object.keys(node)) {
      if (!["id", "operator", "objective", "dependsOn", "evidence", "done", "tools"].includes(key)) throw new Error(`${label}[${index}].${key} is not an accepted plan field`);
    }
    const id = stringAt(node.id, `${label}[${index}].id`);
    if (!ID_PATTERN.test(id)) throw new Error(`${label}[${index}].id must match ${ID_PATTERN}`);
    const operator = stringAt(node.operator, `${label}[${index}].operator`);
    const objective = stringAt(node.objective, `${label}[${index}].objective`);
    if (Buffer.byteLength(objective, "utf8") > LIMITS.planNodeObjectiveBytes) throw new Error(`${label}[${index}].objective exceeds ${LIMITS.planNodeObjectiveBytes} bytes`);
    const done = boundedStringList(node.done, `${label}[${index}].done`);
    if (!done || done.length === 0) throw new Error(`${label}[${index}].done must be a non-empty list`);
    return {
      id,
      operator,
      objective,
      ...(boundedStringList(node.dependsOn, `${label}[${index}].dependsOn`) ? { dependsOn: boundedStringList(node.dependsOn, `${label}[${index}].dependsOn`)! } : {}),
      ...(boundedStringList(node.evidence, `${label}[${index}].evidence`) ? { evidence: boundedStringList(node.evidence, `${label}[${index}].evidence`)! } : {}),
      done: done!,
      ...(boundedStringList(node.tools, `${label}[${index}].tools`) ? { tools: boundedStringList(node.tools, `${label}[${index}].tools`)! } : {}),
    };
  });
}

/** Structural validation used during snapshot restore; semantic checks live in plan.ts. */
export function validateMemory(value: unknown, label: string): WorkflowMemory {
  const raw = objectAt(value, label);
  for (const key of Object.keys(raw)) {
    if (!["steps", "execution"].includes(key)) throw new Error(`${label}.${key} is not an accepted memory field`);
  }
  const stepsRaw = objectAt(raw.steps, `${label}.steps`);
  const steps: Record<string, Checkpoint> = {};
  for (const [stepId, checkpoint] of Object.entries(stepsRaw)) {
    if (!ID_PATTERN.test(stepId)) throw new Error(`${label}.steps key ${stepId} must match ${ID_PATTERN}`);
    steps[stepId] = validateCheckpoint(checkpoint, `${label}.steps.${stepId}`);
  }
  const memory: { steps: Record<string, Checkpoint>; execution?: ExecutionState } = { steps };
  if (raw.execution !== undefined) {
    const execution = objectAt(raw.execution, `${label}.execution`);
    for (const key of Object.keys(execution)) {
      if (!["plan", "revision", "replans", "results"].includes(key)) throw new Error(`${label}.execution.${key} is not an accepted execution field`);
    }
    const planRaw = objectAt(execution.plan, `${label}.execution.plan`);
    if (planRaw.version !== 1) throw new Error(`${label}.execution.plan.version must be 1`);
    const nodes = validatePlanNodes(planRaw.nodes, `${label}.execution.plan.nodes`);
    if (nodes.length < 2 || nodes.length > LIMITS.planNodes) throw new Error(`${label}.execution.plan.nodes must contain 2 to ${LIMITS.planNodes} nodes`);
    const revision = execution.revision;
    const replans = execution.replans;
    if (!isStepIndex(revision)) throw new Error(`${label}.execution.revision must be a positive integer`);
    if (typeof replans !== "number" || !Number.isInteger(replans) || replans < 0 || replans > LIMITS.replans) {
      throw new Error(`${label}.execution.replans must be an integer between 0 and ${LIMITS.replans}`);
    }
    const resultsRaw = objectAt(execution.results, `${label}.execution.results`);
    const results: Record<string, NodeResult> = {};
    for (const [nodeId, result] of Object.entries(resultsRaw)) {
      if (!ID_PATTERN.test(nodeId)) throw new Error(`${label}.execution.results key ${nodeId} must match ${ID_PATTERN}`);
      const validated = validateNodeResult(result, `${label}.execution.results.${nodeId}`);
      if (validated.id !== nodeId) throw new Error(`${label}.execution.results.${nodeId} must carry a matching id`);
      results[nodeId] = validated;
    }
    const plan: DynamicPlan = { version: 1, nodes };
    if (canonicalJsonBytes(plan as unknown as JsonValue) > LIMITS.planBytes) throw new Error(`${label}.execution.plan exceeds ${LIMITS.planBytes} bytes`);
    memory.execution = { plan, revision, replans, results };
  }
  if (canonicalJsonBytes(memory as unknown as JsonValue) > LIMITS.memoryBytes) throw new Error(`${label} exceeds ${LIMITS.memoryBytes} bytes`);
  return memory;
}

function parsePosition(value: unknown, label: string): RunPosition {
  const raw = objectAt(value, label);
  if (raw.kind === "step") {
    const stepId = stringAt(raw.stepId, `${label}.stepId`);
    if (!ID_PATTERN.test(stepId)) throw new Error(`${label}.stepId must match ${ID_PATTERN}`);
    return { kind: "step", stepId };
  }
  if (raw.kind === "node") {
    const stepId = stringAt(raw.stepId, `${label}.stepId`);
    const nodeId = stringAt(raw.nodeId, `${label}.nodeId`);
    if (!ID_PATTERN.test(stepId) || !ID_PATTERN.test(nodeId)) throw new Error(`${label} ids must match ${ID_PATTERN}`);
    const { revision, attempt } = raw;
    if (!isStepIndex(revision) || !isStepIndex(attempt) || (attempt as number) > LIMITS.nodeAttempts) {
      throw new Error(`${label}.revision and attempt must be bounded positive integers`);
    }
    return { kind: "node", stepId, revision: revision as number, nodeId, attempt: attempt as number };
  }
  throw new Error(`${label}.kind must be step or node`);
}

function parseV3(data: Record<string, unknown>): ActiveSnapshotV3 {
  const workflow = stringAt(data.workflow, "snapshot.workflow");
  const runId = stringAt(data.runId, "snapshot.runId");
  const target = typeof data.target === "string" ? data.target : "";
  if (typeof data.delivered !== "boolean") throw new Error("snapshot.delivered must be a boolean");
  const position = parsePosition(data.position, "snapshot.position");
  const memory = validateMemory(data.memory, "snapshot.memory");
  let restoreModel: string | undefined;
  if (data.restoreModel !== undefined) {
    restoreModel = stringAt(data.restoreModel, "snapshot.restoreModel");
    if (!/^[^/\s]+\/[^/\s]+$/.test(restoreModel)) throw new Error("snapshot.restoreModel must be a provider/model-id selector");
  }
  return {
    v: 3,
    status: "active",
    workflow,
    runId,
    position,
    target,
    delivered: data.delivered as boolean,
    memory,
    ...(restoreModel !== undefined ? { restoreModel } : {}),
  };
}

export function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const snapshot = data as Record<string, unknown>;
  if ((snapshot.v === 1 || snapshot.v === 2) && (snapshot.status === "aborted" || snapshot.status === "completed")) {
    return { status: "terminal" };
  }
  if (snapshot.status !== "active") return null;
  if (snapshot.v === 3) {
    try {
      return parseV3(snapshot);
    } catch (error) {
      return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (snapshot.v !== 1 && snapshot.v !== 2) return null;
  if (typeof snapshot.workflow !== "string" || typeof snapshot.runId !== "string") return null;
  if (!isStepIndex(snapshot.step) || typeof snapshot.target !== "string") return null;

  let delivered: boolean;
  if (snapshot.v === 2) {
    if (typeof snapshot.delivered !== "boolean") return null;
    delivered = snapshot.delivered;
  } else {
    if (typeof snapshot.deliveredStep !== "number" || !Number.isInteger(snapshot.deliveredStep)) return null;
    if (snapshot.deliveredStep !== snapshot.step && snapshot.deliveredStep !== snapshot.step - 1) return null;
    delivered = snapshot.deliveredStep === snapshot.step;
  }

  return {
    v: 2,
    status: "active",
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    step: snapshot.step,
    target: snapshot.target,
    delivered,
  };
}

export function latestSnapshot(branch: readonly unknown[]): ParsedSnapshot | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) return parseSnapshot(entry.data);
  }
  return null;
}

export function emptyMemory(): WorkflowMemory {
  return { steps: {} };
}

export function activeSnapshotV3(fields: {
  workflow: string;
  runId: string;
  position: RunPosition;
  target: string;
  delivered: boolean;
  memory: WorkflowMemory;
  restoreModel?: string;
}): ActiveSnapshotV3 {
  return {
    v: 3,
    status: "active",
    workflow: fields.workflow,
    runId: fields.runId,
    position: fields.position,
    target: fields.target,
    delivered: fields.delivered,
    memory: fields.memory,
    ...(fields.restoreModel !== undefined ? { restoreModel: fields.restoreModel } : {}),
  };
}
