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

export type AuthoredBlock = Exclude<Block, SequenceBlock>;
export type AuthoredBlockKind = AuthoredBlock["kind"];
export type AgentFacingBlock = TaskBlock | PlanBlock;
export type CheckpointContractBlock = TaskBlock | ScriptBlock;
export type TaskFrameBlock = CheckpointContractBlock;

/** Top-level authoring keys belong to exactly one authored block grammar. */
export const BLOCK_KIND_KEYS = {
  task: ["id", "run", "tools", "done", "repair", "inputs", "output", "when"],
  plan: ["id", "plan", "inputs", "when"],
  script: ["id", "script", "repair", "inputs", "output", "when"],
  loop: ["id", "for_each", "inputs", "when"],
} as const satisfies Record<AuthoredBlockKind, readonly string[]>;

/** The top-level key whose presence selects each grammar; each one is a member of its kind's own keys. */
export const BLOCK_KIND_DISCRIMINATORS = {
  task: "run",
  plan: "plan",
  script: "script",
  loop: "for_each",
} as const satisfies { [K in AuthoredBlockKind]: (typeof BLOCK_KIND_KEYS)[K][number] };

export const STEP_DISCRIMINATORS = Object.values(BLOCK_KIND_DISCRIMINATORS);

type BlockRoles = {
  readonly guardBearing: boolean;
  readonly agentFacing: boolean;
  readonly restorable: boolean;
  readonly bindable: boolean;
  readonly checkpointContract: boolean;
  readonly toolsBearing: boolean;
};

function blockRoles(block: Block): BlockRoles {
  switch (block.kind) {
    case "task":
      return { guardBearing: true, agentFacing: true, restorable: true, bindable: true, checkpointContract: true, toolsBearing: true };
    case "plan":
      return { guardBearing: true, agentFacing: true, restorable: true, bindable: true, checkpointContract: false, toolsBearing: false };
    case "script":
      return { guardBearing: true, agentFacing: false, restorable: true, bindable: true, checkpointContract: true, toolsBearing: false };
    case "loop":
      return { guardBearing: true, agentFacing: false, restorable: true, bindable: true, checkpointContract: false, toolsBearing: false };
    case "sequence":
      return { guardBearing: false, agentFacing: false, restorable: false, bindable: false, checkpointContract: false, toolsBearing: false };
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

export function isGuardBearingBlock(block: Block): block is AuthoredBlock {
  return blockRoles(block).guardBearing;
}

export function isAgentFacingBlock(block: Block): block is AgentFacingBlock {
  return blockRoles(block).agentFacing;
}

export function isRestorableBlock(block: Block): block is AuthoredBlock {
  return blockRoles(block).restorable;
}

export function isBindableBlock(block: Block): block is AuthoredBlock {
  return blockRoles(block).bindable;
}

export function isCheckpointContractBlock(block: Block): block is CheckpointContractBlock {
  return blockRoles(block).checkpointContract;
}

export function isTaskFrameBlock(block: Block): block is TaskFrameBlock {
  return isCheckpointContractBlock(block);
}

export function isToolsBearingBlock(block: Block): block is TaskBlock {
  return blockRoles(block).toolsBearing;
}

/** The instruction file a block contributes to the frozen definition, if any; membership is answered here, not re-derived per traversal. */
export function instructionFileOf(block: Block): string | undefined {
  return block.kind === "task" ? block.instructionPath : undefined;
}

/** The working directory a block's script declares, if any; retention and dispatch answer through here. */
export function scriptCwdOf(block: Block): string | undefined {
  return block.kind === "script" ? block.script.cwd : undefined;
}

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

