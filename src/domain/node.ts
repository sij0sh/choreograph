import { resolve } from "node:path";
import type { InputBinding, ScriptSpec, TaskBlock, Workflow } from "./workflow.ts";
import { workflowBlocks } from "./workflow.ts";

export type RunnerKind = "agent" | "process";

export type NodeStatus = "running" | "waiting" | "succeeded" | "failed" | "canceled" | "skipped";

export interface AgentNodeSpec {
  readonly runner: "agent";
  readonly blockId: string;
  readonly instructionPath: string;
  readonly tools?: readonly string[];
  readonly done?: readonly string[];
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly recovery?: import("./policy.ts").RecoveryPolicy;
  readonly output?: string;
}

export interface ProcessNodeSpec {
  readonly runner: "process";
  readonly blockId: string;
  readonly spec: ScriptSpec;
  readonly cwd: string;
  readonly containmentRoot?: string;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
}

export type NodeSpec = AgentNodeSpec | ProcessNodeSpec;

export interface NodeInvocation {
  readonly blockId: string;
  readonly key: string;
  readonly runner: RunnerKind;
  readonly status: NodeStatus;
  readonly attempt: number;
}

export interface ArtifactRef {
  readonly invocationKey: string;
  readonly output: string;
}

export function runnerOfBlock(block: import("./workflow.ts").Block): RunnerKind {
  return block.kind === "script" ? "process" : "agent";
}

export function agentSpecOf(block: TaskBlock): AgentNodeSpec {
  return {
    runner: "agent",
    blockId: block.id,
    instructionPath: block.instructionPath,
    ...(block.tools ? { tools: [...block.tools] } : {}),
    ...(block.done ? { done: [...block.done] } : {}),
    ...(block.inputs ? { inputs: block.inputs } : {}),
    ...(block.recovery ? { recovery: block.recovery } : {}),
    ...(block.output !== undefined ? { output: block.output } : {}),
  };
}

export function processSpecOf(block: import("./workflow.ts").ScriptBlock, workflowDir?: string): ProcessNodeSpec {
  const cwd = workflowDir === undefined ? block.script.cwd : resolve(workflowDir, block.script.cwd);
  return {
    runner: "process",
    blockId: block.id,
    spec: block.script,
    cwd,
    ...(workflowDir === undefined ? {} : { containmentRoot: workflowDir }),
    ...(block.inputs ? { inputs: block.inputs } : {}),
  };
}

export function nodeSpecOf(block: import("./workflow.ts").Block, workflowDir?: string): NodeSpec | undefined {
  if (block.kind === "script") return processSpecOf(block, workflowDir);
  if (block.kind === "task") return agentSpecOf(block);
  return undefined;
}

export function compiledNodes(workflow: Workflow, workflowDir?: string): ReadonlyMap<string, NodeSpec> {
  const nodes = new Map<string, NodeSpec>();
  for (const block of workflowBlocks(workflow)) {
    const spec = nodeSpecOf(block, workflowDir);
    if (spec) nodes.set(block.id, spec);
  }
  return nodes;
}
