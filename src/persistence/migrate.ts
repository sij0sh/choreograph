import type { Execution, Frame, PlanExecution } from "../domain/execution.ts";
import { LIMITS } from "../domain/limits.ts";
import { lastSegment, planKeyOf } from "../domain/keys.ts";
import type { Block, SequenceBlock, Workflow } from "../domain/workflow.ts";
import { blockOf } from "../domain/workflow.ts";
import { planInputFor, validateDynamicPlan } from "../planning/validate.ts";

type MigrationResult = { ok: true; execution: Execution } | { ok: false; error: string };

function reject(error: string): MigrationResult {
  return { ok: false, error };
}

function childrenOf(block: Block | undefined): readonly Block[] | undefined {
  return block?.kind === "sequence" ? block.children : undefined;
}

function bodyOf(parent: Frame, block: Block | undefined): SequenceBlock | undefined {
  if (!block) return undefined;
  if (parent.kind === "foreach" && block.kind === "foreach") return block.body;
  if (parent.kind === "repeat" && block.kind === "repeat") return block.body;
  return undefined;
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
    case "foreach": {
      if (parentBlock.kind !== "foreach") return `frame ${parent.key} does not name a for_each block`;
      if (parent.variable !== parentBlock.as) return `frame ${parent.key} variable ${parent.variable} does not match the workflow binding ${parentBlock.as}`;
      const body = bodyOf(parent, parentBlock);
      if (!body || child.blockId !== body.id) return `frame ${parent.key} expects body ${parentBlock.body.id} but holds ${child.blockId}`;
      if (child.kind !== "sequence") return `frame ${parent.key} body must be a sequence frame`;
      const expectedKey = `${parent.key}[${parent.index}]/${body.id}`;
      if (child.key !== expectedKey) return `frame ${child.key} does not match the restored iteration key ${expectedKey}`;
      return undefined;
    }
    case "repeat": {
      if (parentBlock.kind !== "repeat") return `frame ${parent.key} does not name a repeat block`;
      const body = bodyOf(parent, parentBlock);
      if (!body || child.blockId !== body.id) return `frame ${parent.key} expects body ${parentBlock.body.id} but holds ${child.blockId}`;
      if (child.kind !== "sequence") return `frame ${parent.key} body must be a sequence frame`;
      if (parent.iteration >= parentBlock.max) return `frame ${parent.key} iteration ${parent.iteration} exceeds the configured max ${parentBlock.max}`;
      const expectedKey = `${parent.key}#${parent.iteration}/${body.id}`;
      if (child.key !== expectedKey) return `frame ${child.key} does not match the restored iteration key ${expectedKey}`;
      return undefined;
    }
    case "choose": {
      if (parentBlock.kind !== "choose") return `frame ${parent.key} does not name a choose block`;
      const body = parent.caseName === "fallback" ? parentBlock.fallback : parentBlock.cases[parent.caseName];
      if (!body) return `frame ${parent.key} case ${parent.caseName} no longer exists`;
      if (child.blockId !== body.id) return `frame ${parent.key} case ${parent.caseName} expects body ${body.id} but holds ${child.blockId}`;
      if (child.kind !== "sequence") return `frame ${parent.key} case body must be a sequence frame`;
      const expectedKey = `${parent.key}:${parent.caseName}/${body.id}`;
      if (child.key !== expectedKey) return `frame ${child.key} does not match the restored case key ${expectedKey}`;
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
    default:
      return `frame ${parent.key} of kind ${parent.kind} cannot have frames above it`;
  }
}

function validateLeaf(workflow: Workflow, state: Execution, leaf: Frame): string | undefined {
  const block = blockOf(workflow, leaf.blockId);
  if (!block) return `frame ${leaf.key} names unknown block ${leaf.blockId}`;
  switch (leaf.kind) {
    case "task":
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
  for (const key of Object.keys(state.checkpoints)) {
    const last = lastSegment(key);
    const block = blockOf(workflow, last);
    const isNode = Object.values(state.plans).some((plan) => plan.plan.nodes.some((node) => node.id === last));
    if (!block && !isNode) return `checkpoint key ${key} does not belong to any block in the current workflow`;
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
    const nodeIds = new Set(plan.plan.nodes.map((node) => node.id));
    const retained = new Set(Object.keys(plan.results).filter((id) => !nodeIds.has(id)));
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
