import type { RecoveryPolicy } from "./policy.ts";

export interface TaskBlock {
  readonly kind: "task";
  readonly id: string;
  readonly instructionPath: string;
  readonly tools?: readonly string[];
  readonly done?: readonly string[];
  readonly recovery?: RecoveryPolicy;
}

export interface SequenceBlock {
  readonly kind: "sequence";
  readonly id: string;
  readonly children: readonly Block[];
}

export interface PlanBlock {
  readonly kind: "plan";
  readonly id: string;
  readonly operators: readonly string[];
  readonly recovery?: RecoveryPolicy;
}

export type Block = TaskBlock | SequenceBlock | PlanBlock;

export interface OperatorDescriptor {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly tools?: readonly string[];
}

export interface Workflow {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly overviewPath: string;
  readonly piVisibility: boolean;
  readonly tools?: readonly string[];
  readonly root: SequenceBlock;
  readonly operators: ReadonlyMap<string, OperatorDescriptor>;
}

const indexes = new WeakMap<Workflow, ReadonlyMap<string, Block>>();

function collect(block: Block, into: Map<string, Block>): void {
  into.set(block.id, block);
  switch (block.kind) {
    case "sequence":
      block.children.forEach((child) => collect(child, into));
      break;
  }
}

function blockIndex(workflow: Workflow): ReadonlyMap<string, Block> {
  let index = indexes.get(workflow);
  if (!index) {
    const built = new Map<string, Block>();
    collect(workflow.root, built);
    index = built;
    indexes.set(workflow, index);
  }
  return index;
}

export function blockOf(workflow: Workflow, id: string): Block | undefined {
  return blockIndex(workflow).get(id);
}

export function workflowBlocks(workflow: Workflow): readonly Block[] {
  return [...blockIndex(workflow).values()];
}
