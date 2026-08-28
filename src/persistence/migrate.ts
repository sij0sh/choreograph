import type { Execution, Frame, PlanExecution } from "../domain/execution.ts";
import { isArtifactRef } from "../domain/artifacts.ts";
import { LIMITS } from "../domain/limits.ts";
import { lastSegment, planKeyOf, scopeKey } from "../domain/keys.ts";
import type { Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";

type MigrationResult = { ok: true; execution: Execution } | { ok: false; error: string };

function reject(error: string): MigrationResult {
  return { ok: false, error };
}

function contractProblem(workflow: Workflow, contractId: string | undefined, data: unknown, label: string): string | undefined {
  if (contractId === undefined) return undefined;
  const contract = workflow.contracts?.get(contractId);
  if (!contract) return `${label} names missing contract ${contractId}`;
  const errors = contract.validate(data === undefined ? {} : data);
  return errors.length > 0 ? `${label} violates contract ${contractId}: ${errors.join("; ")}` : undefined;
}

function hasRuntimeManagedProcessData(state: Execution, key: string, data: unknown): boolean {
  return state.invocations?.[key]?.status === "waiting" || isArtifactRef(data);
}

function hasContractBearingOperator(workflow: Workflow, operators: readonly string[]): boolean {
  return operators.some((id) => workflow.operators.get(id)?.output !== undefined);
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
      if (child.kind !== "sequence" || child.blockId !== parentBlock.body.id) {
        return `frame ${parent.key} must carry its body sequence ${parentBlock.body.id}, not ${child.blockId}`;
      }
      const loopState = state.loops[parent.key];
      if (!loopState) return `frame ${parent.key} has no matching loop state`;
      if (child.key !== scopeKey(parent.key, loopState.iteration)) {
        return `frame ${parent.key} expects body scope ${scopeKey(parent.key, loopState.iteration)} but holds ${child.key}`;
      }
      if (child.key !== `${parent.key}/${parent.scopeId}`) return `frame ${parent.key} scope ${parent.scopeId} does not match body key ${child.key}`;
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
      if (block.kind === "script") return undefined;
      if (block.kind !== "task") return `frame ${leaf.key} does not name a task`;
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
    if (block?.kind === "task" || block?.kind === "script") {
      const runtimeManaged = block.kind === "script" && hasRuntimeManagedProcessData(state, key, checkpoint.data);
      const problem = runtimeManaged ? undefined : contractProblem(workflow, block.output, checkpoint.data === undefined ? {} : checkpoint.data, `checkpoint ${key}`);
      if (problem) return problem;
    }
    if (nodeEntry) {
      const operator = workflow.operators.get(nodeEntry.node.operator);
      const runtimeManaged = operator?.script !== undefined && hasRuntimeManagedProcessData(state, key, checkpoint.data);
      const problem = runtimeManaged ? undefined : contractProblem(workflow, operator?.output, checkpoint.data === undefined ? {} : checkpoint.data, `checkpoint ${key}`);
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
    const retained = new Set<string>();
    const requiresMetadata = hasContractBearingOperator(workflow, block.operators);
    for (const [metadataId, metadataOperator] of Object.entries(plan.resultOperators ?? {})) {
      if (!Object.hasOwn(plan.results, metadataId)) return `plan execution ${key}.resultOperators.${metadataId} has no matching result`;
      const currentNode = nodeById.get(metadataId);
      if (currentNode && currentNode.operator !== metadataOperator) {
        return `plan result ${key}/${metadataId} has conflicting producer metadata`;
      }
    }
    for (const [resultId, result] of Object.entries(plan.results)) {
      const node = nodeById.get(resultId);
      const metadataOperator = plan.resultOperators?.[resultId];
      if (node && metadataOperator !== undefined && metadataOperator !== node.operator) {
        return `plan result ${key}/${resultId} has conflicting producer metadata`;
      }
      const operatorId = node?.operator ?? metadataOperator;
      if (!operatorId) {
        if (requiresMetadata) return `retained result ${key}/${resultId} has no producer metadata`;
        retained.add(resultId);
        continue;
      }
      const operator = workflow.operators.get(operatorId);
      if (!operator) {
        if (requiresMetadata) return `retained result ${key}/${resultId} uses an unknown producer ${operatorId}`;
        retained.add(resultId);
        continue;
      }
      if (!block.operators.includes(operatorId)) {
        return `retained result ${key}/${resultId} uses operator ${operatorId}, which is not trusted by ${plan.blockId}`;
      }
      const runtimeArtifact = operator.script !== undefined && isArtifactRef(result.data);
      const problem = runtimeArtifact ? undefined : contractProblem(workflow, operator.output, result.data === undefined ? {} : result.data, `node result ${key}/${resultId}`);
      if (problem) return problem;
      if (!node) retained.add(resultId);
    }
    const validation = validateDynamicPlan(plan.plan, planInputFor(workflow, block.operators, retained));
    if ("errors" in validation) {
      return `invalid plan for ${key}: ${validation.errors.join("; ")}`;
    }
  }
  return undefined;
}

export function validateAgainstWorkflow(workflow: Workflow, execution: Execution): MigrationResult {
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
