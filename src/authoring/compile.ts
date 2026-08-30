import { createHash } from "node:crypto";
import { relative } from "node:path";
import { canonicalJson, type JsonValue } from "../domain/json.ts";
import {
  COMPILED_FORMAT_VERSION,
  type CompiledBlock,
  type CompiledContract,
  type CompiledOperator,
  type CompiledSequenceBlock,
  type CompiledTaskBlock,
  type CompiledWorkflowV2,
  type ContentRef,
} from "../domain/compiled-workflow.ts";
import type { Block, LoopBlock, PlanBlock, ScriptBlock, SequenceBlock, TaskBlock, Workflow } from "../domain/workflow.ts";

type InstructionReader = (path: string) => string | undefined;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function compileWorkflow(workflow: Workflow, read: InstructionReader, workflowDir?: string): CompiledWorkflowV2 {
  const relativize = (path: string): string => (workflowDir === undefined ? path : relative(workflowDir, path));
  const contentRef = (path: string, label: string): ContentRef => {
    const content = read(path);
    if (content === undefined) throw new Error(`${label} "${path}" is not readable; compilation cannot freeze it`);
    return { path: relativize(path), sha256: sha256(content), content };
  };

  const convertBlock = (block: Block): CompiledBlock => {
    switch (block.kind) {
      case "task": {
        const task = block as TaskBlock;
        return omitUndefined({
          kind: "task" as const,
          id: task.id,
          instruction: contentRef(task.instructionPath, `task ${task.id} instruction file`),
          ...(task.tools ? { tools: [...task.tools] } : {}),
          ...(task.done ? { done: [...task.done] } : {}),
          ...(task.recovery ? { recovery: structuredClone(task.recovery) } : {}),
          ...(task.inputs ? { inputs: structuredClone(task.inputs) } : {}),
          ...(task.output !== undefined ? { output: task.output } : {}),
          ...(task.guard ? { guard: structuredClone(task.guard) } : {}),
        });
      }
      case "script": {
        const script = block as ScriptBlock;
        return omitUndefined({
          kind: "script" as const,
          id: script.id,
          script: structuredClone(script.script),
          ...(script.recovery ? { recovery: structuredClone(script.recovery) } : {}),
          ...(script.inputs ? { inputs: structuredClone(script.inputs) } : {}),
          ...(script.output !== undefined ? { output: script.output } : {}),
          ...(script.guard ? { guard: structuredClone(script.guard) } : {}),
        });
      }
      case "sequence":
        return { kind: "sequence", id: block.id, children: block.children.map(convertBlock) };
      case "plan": {
        const plan = block as PlanBlock;
        return omitUndefined({
          kind: "plan" as const,
          id: plan.id,
          operators: [...plan.operators],
          ...(plan.recovery ? { recovery: structuredClone(plan.recovery) } : {}),
          ...(plan.inputs ? { inputs: structuredClone(plan.inputs) } : {}),
          ...(plan.guard ? { guard: structuredClone(plan.guard) } : {}),
        });
      }
      case "loop": {
        const loop = block as LoopBlock;
        return omitUndefined({
          kind: "loop" as const,
          id: loop.id,
          body: convertBlock(loop.body) as CompiledTaskBlock,
          itemsBinding: structuredClone(loop.itemsBinding),
          maxIterations: loop.maxIterations,
          ...(loop.guard ? { guard: structuredClone(loop.guard) } : {}),
        });
      }
    }
  };

  const operators: Record<string, CompiledOperator> = {};
  for (const [id, operator] of workflow.operators) {
    operators[id] = omitUndefined({
      id,
      path: relativize(operator.path),
      description: operator.description,
      ...(operator.tools ? { tools: [...operator.tools] } : {}),
      ...(operator.output !== undefined ? { output: operator.output } : {}),
      content: contentRef(operator.path, `operator ${id} file`),
    });
  }

  const contracts: Record<string, CompiledContract> = {};
  for (const [id, contract] of workflow.contracts) {
    contracts[id] = omitUndefined({
      id,
      path: relativize(contract.path),
      ...(contract.schema !== undefined ? { schema: structuredClone(contract.schema) } : {}),
    });
  }

  const inputEdges: Record<string, readonly string[]> = {};
  for (const [consumer, producers] of workflow.inputEdges) inputEdges[consumer] = [...producers];

  const compiled: Omit<CompiledWorkflowV2, "digest"> = {
    formatVersion: COMPILED_FORMAT_VERSION,
    name: workflow.name,
    title: workflow.title,
    description: workflow.description,
    overview: contentRef(workflow.overviewPath, "workflow overview file"),
    piVisibility: workflow.piVisibility,
    ...(workflow.tools ? { tools: [...workflow.tools] } : {}),
    root: convertBlock(workflow.root) as CompiledSequenceBlock,
    operators,
    contracts,
    inputEdges,
  };
  const digest = createHash("sha256").update(canonicalJson(compiled as unknown as JsonValue)).digest("hex");
  return deepFreeze({ ...compiled, digest });
}
