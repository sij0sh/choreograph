import type { JsonValue } from "./json.ts";
import type { RecoveryPolicy } from "./policy.ts";

export interface DataReference {
  readonly root: string;
  readonly path: readonly string[];
}

export type ValueSource = { readonly ref: DataReference } | { readonly literal: JsonValue };

export type Predicate =
  | { readonly op: "equals"; readonly left: ValueSource; readonly right: ValueSource }
  | { readonly op: "exists"; readonly value: ValueSource }
  | { readonly op: "contains"; readonly container: ValueSource; readonly value: ValueSource }
  | { readonly op: "not"; readonly predicate: Predicate }
  | { readonly op: "all"; readonly predicates: readonly Predicate[] }
  | { readonly op: "any"; readonly predicates: readonly Predicate[] };

export interface TaskBlock {
  readonly kind: "task";
  readonly id: string;
  readonly instructionPath: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly done?: readonly string[];
  readonly recovery?: RecoveryPolicy;
}

export interface SequenceBlock {
  readonly kind: "sequence";
  readonly id: string;
  readonly children: readonly Block[];
}

export interface ForEachBlock {
  readonly kind: "foreach";
  readonly id: string;
  readonly items: DataReference;
  readonly as: string;
  readonly body: SequenceBlock;
}

export interface RepeatBlock {
  readonly kind: "repeat";
  readonly id: string;
  readonly max: number;
  readonly until?: Predicate;
  readonly body: SequenceBlock;
}

export interface ChooseBlock {
  readonly kind: "choose";
  readonly id: string;
  readonly value: DataReference;
  readonly cases: Readonly<Record<string, SequenceBlock>>;
  readonly fallback?: SequenceBlock;
}

export interface PlanBlock {
  readonly kind: "plan";
  readonly id: string;
  readonly operators: readonly string[];
  readonly recovery?: RecoveryPolicy;
}

export type Block = TaskBlock | SequenceBlock | ForEachBlock | RepeatBlock | ChooseBlock | PlanBlock;

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
  readonly model?: string;
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
    case "foreach":
    case "repeat":
      collect(block.body, into);
      break;
    case "choose":
      Object.values(block.cases).forEach((body) => collect(body, into));
      if (block.fallback) collect(block.fallback, into);
      break;
  }
}

export function blockIndex(workflow: Workflow): ReadonlyMap<string, Block> {
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
