import { canonicalJsonBytes, ID_PATTERN, LIMITS, type DynamicPlan, type DynamicPlanNode, type ExecutionState, type OperatorDescriptor } from "./types.ts";

export interface PlanValidationInput {
  /** Operator registry from the workflow manifest. */
  readonly operators: ReadonlyMap<string, OperatorDescriptor>;
  /** Captured Pi baseline tool names. */
  readonly baselineTools: ReadonlySet<string>;
  /** Workflow-level tool ceiling, when configured. */
  readonly workflowTools?: ReadonlySet<string>;
  /** Executor-step tool ceiling, when configured. */
  readonly stepTools?: ReadonlySet<string>;
  /** Completed node ids retained from earlier revisions, usable as dependencies. */
  readonly retainedResultIds: ReadonlySet<string>;
}

const PLAN_KEYS = ["version", "nodes"];
const NODE_KEYS = ["id", "operator", "objective", "dependsOn", "evidence", "done", "tools"];

function boundedList(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  if (value.length > max) throw new Error(`${label} must have at most ${max} items`);
  const items = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string`);
    if (Buffer.byteLength(item, "utf8") > LIMITS.planNodeObjectiveBytes) throw new Error(`${label}[${index}] exceeds ${LIMITS.planNodeObjectiveBytes} bytes`);
    return item;
  });
  if (new Set(items).size !== items.length) throw new Error(`${label} must not contain duplicates`);
  return items;
}

/**
 * Validate a model-generated plan in full. Returns every schema violation at
 * once so the planner can correct the whole plan in one retry.
 */
export function validateDynamicPlan(value: unknown, input: PlanValidationInput): { plan: DynamicPlan } | { errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { errors: ["plan must be an object"] };
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PLAN_KEYS.includes(key)) errors.push(`plan.${key} is not an accepted plan field`);
  }
  if (raw.version !== 1) errors.push("plan.version must be 1");
  if (!Array.isArray(raw.nodes)) return { errors: [...errors, "plan.nodes must be a list"] };
  if (raw.nodes.length < 2 || raw.nodes.length > LIMITS.planNodes) {
    errors.push(`plan.nodes must contain 2 to ${LIMITS.planNodes} nodes`);
  }
  const nodes: DynamicPlanNode[] = [];
  const seen = new Set<string>();
  raw.nodes.forEach((nodeValue, index) => {
    const label = `plan.nodes[${index}]`;
    if (typeof nodeValue !== "object" || nodeValue === null || Array.isArray(nodeValue)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const node = nodeValue as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (!NODE_KEYS.includes(key)) errors.push(`${label}.${key} is not an accepted node field`);
    }
    if (typeof node.id !== "string" || !ID_PATTERN.test(node.id)) {
      errors.push(`${label}.id must match ${ID_PATTERN}`);
      return;
    }
    if (seen.has(node.id)) errors.push(`${label}.id duplicates ${node.id}`);
    if (input.retainedResultIds.has(node.id)) errors.push(`${label}.id ${node.id} is already a retained result; new revisions must use new ids for new work`);
    seen.add(node.id);
    const operator = input.operators.get(node.operator as string);
    if (typeof node.operator !== "string" || !operator) {
      errors.push(`${label}.operator must name a known operator`);
      return;
    }
    if (typeof node.objective !== "string" || !node.objective.trim()) {
      errors.push(`${label}.objective must be a non-empty string`);
    } else if (Buffer.byteLength(node.objective, "utf8") > LIMITS.planNodeObjectiveBytes) {
      errors.push(`${label}.objective exceeds ${LIMITS.planNodeObjectiveBytes} bytes`);
    }
    let dependsOn: string[] | undefined;
    let evidence: string[] | undefined;
    let done: string[] | undefined;
    let tools: string[] | undefined;
    try {
      dependsOn = boundedList(node.dependsOn, `${label}.dependsOn`, LIMITS.planNodeListItems);
      evidence = boundedList(node.evidence, `${label}.evidence`, LIMITS.planNodeListItems);
      done = boundedList(node.done, `${label}.done`, LIMITS.planNodeListItems);
      tools = boundedList(node.tools, `${label}.tools`, LIMITS.planNodeListItems);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!done || done.length === 0) errors.push(`${label}.done must be a non-empty list`);
    if (dependsOn?.includes(node.id as string)) errors.push(`${label}.dependsOn must not include its own node`);
    if (dependsOn) {
      const earlier = new Set(nodes.map((known) => known.id));
      for (const dependency of dependsOn) {
        if (!ID_PATTERN.test(dependency)) {
          errors.push(`${label}.dependsOn entry ${dependency} must match ${ID_PATTERN}`);
        } else if (!earlier.has(dependency) && !input.retainedResultIds.has(dependency)) {
          errors.push(`${label}.dependsOn entry ${dependency} must name an earlier node or a retained completed result`);
        }
      }
    }
    if (done) {
      for (const criterion of done) {
        if (!ID_PATTERN.test(criterion)) errors.push(`${label}.done entry ${criterion} must match ${ID_PATTERN}`);
      }
    }
    if (tools) {
      for (const tool of tools) {
        if (!input.baselineTools.has(tool)) {
          errors.push(`${label}.tools entry ${tool} is not in the captured baseline`);
        } else if (input.workflowTools && !input.workflowTools.has(tool)) {
          errors.push(`${label}.tools entry ${tool} exceeds the workflow tool ceiling`);
        } else if (input.stepTools && !input.stepTools.has(tool)) {
          errors.push(`${label}.tools entry ${tool} exceeds the executor step tool ceiling`);
        } else if (operator.tools && !operator.tools.has(tool)) {
          errors.push(`${label}.tools entry ${tool} exceeds the ${operator.id} operator tool ceiling`);
        }
      }
    }
    nodes.push({
      id: node.id as string,
      operator: node.operator as string,
      objective: node.objective as string,
      ...(dependsOn ? { dependsOn } : {}),
      ...(evidence ? { evidence } : {}),
      ...(done ? { done } : {}),
      ...(tools ? { tools } : {}),
    } as DynamicPlanNode);
  });
  if (errors.length > 0) return { errors };
  const plan: DynamicPlan = { version: 1, nodes: nodes as DynamicPlanNode[] };
  if (canonicalJsonBytes(plan as unknown as Parameters<typeof canonicalJsonBytes>[0]) > LIMITS.planBytes) {
    return { errors: [`plan exceeds ${LIMITS.planBytes} bytes after canonical JSON serialization`] };
  }
  return { plan };
}

/** The first node in declaration order without a completed result. */
export function firstIncompleteNode(execution: ExecutionState): DynamicPlanNode | undefined {
  return execution.plan.nodes.find((node) => execution.results[node.id] === undefined);
}

/**
 * Remove the requested results and every current-revision result that
 * transitively depends on them. Returns the updated execution plus the
 * invalidated ids in declaration order.
 */
export function invalidateResults(execution: ExecutionState, requested: readonly string[]): { execution: ExecutionState; removed: string[] } {
  const results = { ...execution.results };
  const removed = new Set<string>();
  for (const id of requested) {
    if (results[id] !== undefined) {
      delete results[id];
      removed.add(id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of execution.plan.nodes) {
      if (removed.has(node.id) || results[node.id] === undefined) continue;
      const dependsOnInvalidated = (node.dependsOn ?? []).some((dependency) => removed.has(dependency));
      if (dependsOnInvalidated) {
        delete results[node.id];
        removed.add(node.id);
        changed = true;
      }
    }
  }
  const ordered = execution.plan.nodes.filter((node) => removed.has(node.id)).map((node) => node.id);
  return { execution: { ...execution, results }, removed: ordered };
}
