import type { JsonValue } from "../domain/json.ts";
import { canonicalJsonBytes } from "../domain/json.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import type { OperatorDescriptor, Workflow } from "../domain/workflow.ts";
import type { DynamicPlan, PlanNode } from "./schema.ts";

interface PlanValidationInput {
  readonly operators: ReadonlyMap<string, OperatorDescriptor>;
  readonly allowedOperators: readonly string[];
  readonly retainedResultIds: ReadonlySet<string>;
}

const PLAN_KEYS = ["version", "nodes"];
const NODE_KEYS = ["id", "operator", "objective", "dependsOn", "evidence", "done"];

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
  const allowed = new Set(input.allowedOperators);
  const nodes: PlanNode[] = [];
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
    if (typeof node.operator !== "string" || !input.operators.get(node.operator) || !allowed.has(node.operator)) {
      errors.push(`${label}.operator must name one of the block's trusted operators`);
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
    try {
      dependsOn = boundedList(node.dependsOn, `${label}.dependsOn`, LIMITS.planNodeListItems);
      evidence = boundedList(node.evidence, `${label}.evidence`, LIMITS.planNodeListItems);
      done = boundedList(node.done, `${label}.done`, LIMITS.planNodeListItems);
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
    nodes.push({
      id: node.id as string,
      operator: node.operator as string,
      objective: node.objective as string,
      ...(dependsOn ? { dependsOn } : {}),
      ...(evidence ? { evidence } : {}),
      ...(done ? { done: done! } : {}),
    } as PlanNode);
  });
  if (errors.length > 0) return { errors };
  const plan: DynamicPlan = { version: 1, nodes: nodes as PlanNode[] };
  if (canonicalJsonBytes(plan as unknown as JsonValue) > LIMITS.planBytes) {
    return { errors: [`plan exceeds ${LIMITS.planBytes} bytes after canonical JSON serialization`] };
  }
  return { plan };
}

export function planInputFor(workflow: Workflow, allowedOperators: readonly string[], retainedResultIds: ReadonlySet<string>): PlanValidationInput {
  return { operators: workflow.operators, allowedOperators, retainedResultIds };
}
