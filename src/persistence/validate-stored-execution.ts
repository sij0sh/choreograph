import type { Execution, Frame, PlanExecution } from "../domain/execution.ts";
import { isArtifactRef } from "../domain/artifacts.ts";
import { contractError } from "../domain/contract.ts";
import { LIMITS } from "../domain/limits.ts";
import { lastSegment, planKeyOf, scopeKey } from "../domain/keys.ts";
import type { Workflow } from "../domain/workflow.ts";
import { blockOf, isCheckpointContractBlock, isTaskFrameBlock } from "../domain/workflow.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";
import { loopStateForFrame } from "./run-state-schema.ts";

type ValidationResult = { ok: true; execution: Execution } | { ok: false; error: string };

function reject(error: string): ValidationResult {
  return { ok: false, error };
}

function hasRuntimeManagedProcessData(state: Execution, key: string, data: unknown): boolean {
  return state.invocations?.[key]?.status === "waiting" || isArtifactRef(data);
}


function validatePair(workflow: Workflow, state: Execution, parent: Frame, child: Frame, plans: Readonly<Record<string, PlanExecution>>): string | undefined {
  const parentBlock = blockOf(workflow, parent.blockId);
  if (!parentBlock) return `frame ${parent.key} names unknown block ${parent.blockId}`;
  switch (parent.kind) {
    case "sequence": {
      if (parentBlock.kind !== "sequence") return `frame ${parent.key} does not name a sequence`;
      const children = parentBlock.children;
      if (parent.index < 1 || parent.index > children.length) return `frame ${parent.key} index ${parent.index} is outside the workflow`;
      const expected = children[parent.index - 1];
      if (expected.id !== child.blockId) return `frame ${parent.key} expects child ${expected.id} at index ${parent.index} but holds ${child.blockId}`;
      return undefined;
    }
    case "plan": {
      if (parentBlock.kind !== "plan") return `frame ${parent.key} does not name a plan block`;
      if (parent.mode !== "execute") return `frame ${parent.key} in create mode cannot have frames above it`;
      const execution = plans[parent.key];
      if (!execution || execution.blockId !== parent.blockId) return `frame ${parent.key} has no matching plan execution`;
      if (child.kind !== "node") return `frame ${parent.key} must carry a node frame, not ${child.kind}`;
      if (!execution.plan.nodes.some((node) => node.id === child.nodeId)) return `node ${child.nodeId} is not in the active plan for ${parent.key}`;
      if (child.attempt < 1 || child.attempt > LIMITS.nodeAttempts + 1) return `node ${child.nodeId} attempt ${child.attempt} is out of bounds`;
      return undefined;
    }
    case "loop": {
      if (parentBlock.kind !== "loop") return `frame ${parent.key} does not name a loop block`;
      if (child.kind !== "task" || child.blockId !== parentBlock.body.id) {
        return `frame ${parent.key} must carry its body task ${parentBlock.body.id}, not ${child.blockId}`;
      }
      const loopState = state.loops[parent.key];
      if (!loopStateForFrame(state, parent)) return `frame ${parent.key} has no matching loop state`;
      const expected = `${scopeKey(parent.key, loopState.iteration)}/${parentBlock.body.id}`;
      if (child.key !== expected) return `frame ${parent.key} expects body position ${expected} but holds ${child.key}`;
      if (loopState.iteration > parentBlock.maxIterations) {
        return `loop ${parentBlock.id} iteration ${loopState.iteration} exceeds its cap of ${parentBlock.maxIterations}`;
      }
      return undefined;
    }
    default:
      return `frame ${parent.key} of kind ${parent.kind} cannot have frames above it`;
  }
}

function validateLeaf(workflow: Workflow, state: Execution, leaf: Frame): string | undefined {
  const block = blockOf(workflow, leaf.blockId);
  if (!block) return `frame ${leaf.key} names unknown block ${leaf.blockId}`;
  switch (leaf.kind) {
    case "task":
      if (!isTaskFrameBlock(block)) return `frame ${leaf.key} does not name a task`;
      return undefined;
    case "node":
    case "plan": {
      if (block.kind !== "plan") return `frame ${leaf.key} does not name a plan block`;
      if (leaf.kind === "plan") return undefined;
      const execution = state.plans[planKeyOf(leaf.key)] ?? state.plans[leaf.key];
      if (!execution) return `node frame ${leaf.key} has no plan execution`;
      if (!execution.plan.nodes.some((node) => node.id === leaf.nodeId)) return `node ${leaf.nodeId} is not in the active plan`;
      return undefined;
    }
    default:
      return `frame ${leaf.key} of kind ${leaf.kind} cannot be the leaf`;
  }
}

function validateCheckpoints(workflow: Workflow, state: Execution): string | undefined {
  for (const [key, checkpoint] of Object.entries(state.checkpoints)) {
    const last = lastSegment(key);
    const block = blockOf(workflow, last);
    const nodeEntry = Object.entries(state.plans)
      .flatMap(([planKey, plan]) => plan.plan.nodes.map((node) => ({ planKey, node })))
      .find(({ planKey, node }) => `${planKey}/${node.id}` === key);
    if (!block && !nodeEntry) return `checkpoint key ${key} does not belong to any block in the current workflow`;
    if (checkpoint.skipped === true) continue;
    if (block && isCheckpointContractBlock(block)) {
      const runtimeManaged = block.kind === "script" && hasRuntimeManagedProcessData(state, key, checkpoint.data);
      const problem = runtimeManaged ? undefined : contractError(workflow, block.output, checkpoint.data === undefined ? {} : checkpoint.data, `checkpoint ${key}`);
      if (problem) return problem;
    }
    if (nodeEntry) {
      const operator = workflow.operators.get(nodeEntry.node.operator);
      const problem = contractError(workflow, operator?.output, checkpoint.data === undefined ? {} : checkpoint.data, `checkpoint ${key}`);
      if (problem) return problem;
    }
  }
  for (const [key, plan] of Object.entries(state.plans)) {
    const block = blockOf(workflow, plan.blockId);
    if (!block) return `plan execution ${key} names unknown block ${plan.blockId}`;
    if (block.kind !== "plan") return `plan execution ${key} names block ${plan.blockId}, which is not a plan`;
    const allowed = new Set(block.operators);
    for (const node of plan.plan.nodes) {
      if (!workflow.operators.has(node.operator) || !allowed.has(node.operator)) {
        return `plan node ${node.id} uses operator ${node.operator}, which is not trusted by ${plan.blockId}`;
      }
    }
    const nodeById = new Map(plan.plan.nodes.map((node) => [node.id, node]));
    for (const [resultId, result] of Object.entries(plan.results)) {
      const node = nodeById.get(resultId);
      if (!node) return `plan result ${key}/${resultId} has no matching node in the current plan`;
      const operator = workflow.operators.get(node.operator);
      if (!operator) return `plan result ${key}/${resultId} uses unknown operator ${node.operator}`;
      const problem = contractError(workflow, operator.output, result.data === undefined ? {} : result.data, `node result ${key}/${resultId}`);
      if (problem) return problem;
    }
    const validation = validateDynamicPlan(plan.plan, planInputFor(workflow, block.operators));
    if ("errors" in validation) {
      return `invalid plan for ${key}: ${validation.errors.join("; ")}`;
    }
  }
  return undefined;
}

export function validateAgainstWorkflow(workflow: Workflow, execution: Execution): ValidationResult {
  if (execution.workflowName !== workflow.name) return reject(`snapshot belongs to workflow ${execution.workflowName}, not ${workflow.name}`);
  const stack = execution.stack;
  const rootFrame = stack[0];
  if (!rootFrame || rootFrame.kind !== "sequence" || rootFrame.blockId !== workflow.root.id) {
    return reject(`snapshot does not start at the root sequence ${workflow.root.id}`);
  }
  for (let i = 0; i < stack.length - 1; i += 1) {
    const problem = validatePair(workflow, execution, stack[i], stack[i + 1], execution.plans);
    if (problem) return reject(problem);
  }
  const leafProblem = validateLeaf(workflow, execution, stack[stack.length - 1]);
  if (leafProblem) return reject(leafProblem);
  const checkpointProblem = validateCheckpoints(workflow, execution);
  if (checkpointProblem) return reject(checkpointProblem);
  return { ok: true, execution };
}
