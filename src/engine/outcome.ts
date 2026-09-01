import type { Checkpoint, TransitionStatus } from "../domain/checkpoint.ts";
import { checkpointErrors, validateCheckpoint } from "../domain/checkpoint.ts";
import { contractError as contractErrorFor } from "../domain/contract.ts";
import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import { planKeyOf } from "../domain/keys.ts";
import { canonicalJsonBytes, type JsonValue } from "../domain/json.ts";
import type { Run, Frame, PlanNodeFrame } from "../domain/run.ts";
import { blockOf, type Workflow } from "../domain/workflow.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";

export type Issue = {
  readonly target: string;
  readonly reason: string;
};

type OutcomePayloads = {
  completed: { readonly met?: readonly string[] };
  "needs-work": { readonly issues?: readonly Issue[] };
  blocked: {};
};

type AssertNever<T extends never> = T;
type MissingOutcomeStatus = AssertNever<Exclude<TransitionStatus, keyof OutcomePayloads>>;
type UnexpectedOutcomeStatus = AssertNever<Exclude<keyof OutcomePayloads, TransitionStatus>>;

export type TaskOutcome = {
  [Status in keyof OutcomePayloads]: { readonly status: Status; readonly key: string; readonly checkpoint: Checkpoint } & OutcomePayloads[Status];
}[keyof OutcomePayloads];

export function checkCriteria(criteria: readonly string[], met: readonly string[]): string | undefined {
  const known = new Set(criteria);
  const unknownIds = met.filter((id) => !known.has(id));
  const metSet = new Set(met);
  const missingIds = criteria.filter((id) => !metSet.has(id));
  if (metSet.size !== met.length) return "met must not contain duplicates";
  if (unknownIds.length === 0 && missingIds.length === 0) return undefined;
  const parts: string[] = [];
  if (unknownIds.length > 0) parts.push(`unknown criterion id: ${unknownIds.join(", ")}`);
  if (missingIds.length > 0) parts.push(`completion must list every required criterion; missing: ${missingIds.join(", ")}`);
  if (criteria.length > 0) parts.push(`required ids for this position: ${criteria.map((id) => `\`${id}\``).join(", ")}`);
  return parts.join("; ");
}

export function joined(errors: readonly string[]): string | undefined {
  const unique = [...new Set(errors.filter((error) => error.trim().length > 0))];
  return unique.length > 0 ? unique.join("; ") : undefined;
}

export function outcomeShapeErrors(outcome: TaskOutcome): string[] {
  const errors: string[] = [];
  const raw = outcome as { met?: unknown; issues?: unknown };
  if (outcome.status !== "completed" && raw.met !== undefined) errors.push("met is only valid with status \"completed\"");
  if (outcome.status !== "needs-work" && raw.issues !== undefined) errors.push("issues is only valid with status \"needs-work\"");
  if (raw.met !== undefined) {
    if (!Array.isArray(raw.met)) {
      errors.push("met must be a list of criterion ids");
    } else {
      const offending = [...new Set(raw.met.filter((id) => typeof id !== "string" || !ID_PATTERN.test(id)))];
      if (offending.length > 0) errors.push(`met entries must match ${ID_PATTERN} (offending: ${offending.map((id) => JSON.stringify(id)).join(", ")}); use the required ids below verbatim`);
    }
  }
  if (raw.issues !== undefined) {
    if (!Array.isArray(raw.issues)) {
      errors.push("issues must be a list");
    } else {
      raw.issues.forEach((issue, index) => {
        if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
          errors.push(`issues[${index}] must be an object`);
          return;
        }
        const entry = issue as { target?: unknown; reason?: unknown };
        if (typeof entry.target !== "string" || !entry.target.trim()) errors.push(`issues[${index}].target must be a non-empty string`);
        if (typeof entry.reason !== "string" || !entry.reason.trim()) errors.push(`issues[${index}].reason must be a non-empty string`);
      });
    }
  }
  return errors;
}

export function completedProblems(workflow: Workflow, state: Run, leaf: Frame, outcome: Extract<TaskOutcome, { status: "completed" }>, planExempt: boolean): string[] {
  const errors = [...outcomeShapeErrors(outcome), ...checkpointErrors(outcome.checkpoint, "checkpoint", planExempt)];
  const met = outcome.met ?? [];
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    if (!block || block.kind !== "task") {
      errors.push(`frame ${leaf.key} does not name a task`);
      return errors;
    }
    const criteria = checkCriteria(block.done ?? [], met);
    if (criteria) errors.push(criteria);
    const contract = contractErrorFor(workflow, block.output, outcome.checkpoint.data, `task ${leaf.key} output`);
    if (contract) errors.push(contract);
    return errors;
  }
  if (leaf.kind === "plan") {
    const block = blockOf(workflow, leaf.blockId);
    if (!block || block.kind !== "plan") {
      errors.push(`frame ${leaf.key} does not name a plan block`);
      return errors;
    }
    const planValue = (outcome.checkpoint.data as { plan?: unknown } | undefined)?.plan;
    if (planValue === undefined) {
      errors.push("plan creation completion must carry checkpoint.data.plan");
      return errors;
    }
    const validation = validateDynamicPlan(planValue, planInputFor(workflow, block.operators));
    if ("errors" in validation) errors.push(`invalid plan: ${validation.errors.join("; ")}`);
    return errors;
  }
  if (leaf.kind === "node") {
    const planKey = planKeyOfNode(leaf);
    const record = state.plans[planKey];
    if (!record || record.blockId !== leaf.blockId) {
      errors.push(`node frame ${leaf.key} has no plan execution`);
      return errors;
    }
    const node = record.plan.nodes.find((entry) => entry.id === leaf.nodeId);
    if (!node) {
      errors.push(`node ${leaf.nodeId} is not in the active plan`);
      return errors;
    }
    const criteria = checkCriteria(node.done, met);
    if (criteria) errors.push(criteria);
    const operator = workflow.operators.get(node.operator);
    const contract = contractErrorFor(workflow, operator?.output, outcome.checkpoint.data, `node result ${node.id}`);
    if (contract) errors.push(contract);
    try {
      const result = validateCheckpoint(outcome.checkpoint, `node result ${node.id}`);
      const bytes = canonicalJsonBytes(result as unknown as JsonValue);
      if (bytes > LIMITS.nodeResultBytes) {
        errors.push(`node result ${node.id} exceeds ${LIMITS.nodeResultBytes} bytes (was ${bytes}); trim \`evidence\`/\`data\` or narrow the node result`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return errors;
  }
  return errors;
}

export function blockedProblems(workflow: Workflow, state: Run, leaf: Frame, outcome: Extract<TaskOutcome, { status: "blocked" }>, planExempt: boolean): string[] {
  const errors = [...outcomeShapeErrors(outcome), ...checkpointErrors(outcome.checkpoint, "checkpoint", planExempt)];
  const contract = contractErrorFor(workflow, outputContractFor(workflow, state, leaf), outcome.checkpoint.data, `checkpoint ${leaf.key}`);
  if (contract) errors.push(contract);
  return errors;
}

export function planKeyOfNode(node: PlanNodeFrame): string {
  return planKeyOf(node.key);
}

function outputContractFor(workflow: Workflow, state: Run, leaf: Frame): string | undefined {
  if (leaf.kind === "task") {
    const block = blockOf(workflow, leaf.blockId);
    return block?.kind === "task" ? block.output : undefined;
  }
  if (leaf.kind !== "node") return undefined;
  const record = state.plans[planKeyOfNode(leaf)];
  const node = record?.plan.nodes.find((entry) => entry.id === leaf.nodeId);
  return node ? workflow.operators.get(node.operator)?.output : undefined;
}
