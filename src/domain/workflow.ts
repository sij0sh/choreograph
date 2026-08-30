import type { RecoveryPolicy } from "./policy.ts";
import type { ContractDescriptor } from "./contract.ts";
import type { GuardClause } from "./guard.ts";
export type { ContractDescriptor } from "./contract.ts";
export type { GuardClause } from "./guard.ts";

export interface InputBinding {
  readonly from: string;
  readonly select?: string;
}

export interface TaskBlock {
  readonly kind: "task";
  readonly id: string;
  readonly instructionPath: string;
  readonly tools?: readonly string[];
  readonly done?: readonly string[];
  readonly recovery?: RecoveryPolicy;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly output?: string;
  readonly guard?: GuardClause;
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
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly guard?: GuardClause;
}

export interface LoopBlock {
  readonly kind: "loop";
  readonly id: string;
  readonly body: TaskBlock;
  readonly itemsBinding: InputBinding;
  readonly maxIterations: number;
  readonly guard?: GuardClause;
}

export interface ScriptSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly inheritEnv?: readonly string[];
  readonly timeoutMs: number;
  readonly acceptedExitCodes: readonly number[];
  readonly stdout: "json" | "text" | "none";
  readonly stderr: "json" | "text" | "none";
  readonly maxCaptureBytes: number;
  /** Files captured from the script's working directory into the artifact store after an accepted exit. */
  readonly files?: readonly ScriptFileCapture[];
}

/** One declared file output: a capture name and a path relative to the script's cwd. */
export interface ScriptFileCapture {
  readonly name: string;
  readonly path: string;
}

export interface ScriptBlock {
  readonly kind: "script";
  readonly id: string;
  readonly script: ScriptSpec;
  readonly recovery?: RecoveryPolicy;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly guard?: GuardClause;
  readonly output?: string;
}

export type Block = TaskBlock | SequenceBlock | PlanBlock | LoopBlock | ScriptBlock;

export interface OperatorDescriptor {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly output?: string;
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
  readonly contracts: ReadonlyMap<string, ContractDescriptor>;
  readonly inputEdges: ReadonlyMap<string, readonly string[]>;
}

const indexes = new WeakMap<Workflow, ReadonlyMap<string, Block>>();

function collect(block: Block, into: Map<string, Block>): void {
  into.set(block.id, block);
  switch (block.kind) {
    case "sequence":
      block.children.forEach((child) => collect(child, into));
      break;
    case "loop":
      collect(block.body, into);
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

