import type { JsonValue } from "./json.ts";
import type { GuardClause } from "./guard.ts";
import type { RecoveryPolicy } from "./policy.ts";
import type { InputBinding, ScriptSpec } from "./workflow.ts";

export const COMPILED_FORMAT_VERSION = 2;

/** An immutable content reference: workflow-relative path, content digest, and the frozen content itself. */
export interface ContentRef {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
}

export interface CompiledTaskBlock {
  readonly kind: "task";
  readonly id: string;
  readonly instruction: ContentRef;
  readonly tools?: readonly string[];
  readonly done?: readonly string[];
  readonly recovery?: RecoveryPolicy;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly output?: string;
  readonly guard?: GuardClause;
}

export interface CompiledScriptBlock {
  readonly kind: "script";
  readonly id: string;
  readonly script: ScriptSpec;
  readonly recovery?: RecoveryPolicy;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly output?: string;
  readonly guard?: GuardClause;
}

export interface CompiledSequenceBlock {
  readonly kind: "sequence";
  readonly id: string;
  readonly children: readonly CompiledBlock[];
}

export interface CompiledPlanBlock {
  readonly kind: "plan";
  readonly id: string;
  readonly operators: readonly string[];
  readonly recovery?: RecoveryPolicy;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly guard?: GuardClause;
}

export interface CompiledLoopBlock {
  readonly kind: "loop";
  readonly id: string;
  readonly mode: "for-each" | "repeat-until";
  readonly body: CompiledSequenceBlock;
  readonly itemsBinding?: InputBinding;
  readonly condition?: GuardClause;
  readonly maxIterations: number;
  readonly recovery?: RecoveryPolicy;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
  readonly guard?: GuardClause;
}

export type CompiledBlock =
  | CompiledTaskBlock
  | CompiledScriptBlock
  | CompiledSequenceBlock
  | CompiledPlanBlock
  | CompiledLoopBlock;

export interface CompiledOperator {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly output?: string;
  readonly script?: ScriptSpec;
  readonly content: ContentRef;
}

export interface CompiledContract {
  readonly id: string;
  readonly path: string;
  readonly schema?: JsonValue;
}

/**
 * The complete, normalized, serializable, immutable form of a workflow definition.
 * Every behavior-shaping detail of the definition is present, so the digest covers all of it.
 */
export interface CompiledWorkflowV2 {
  readonly formatVersion: typeof COMPILED_FORMAT_VERSION;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly overview: ContentRef;
  readonly piVisibility: boolean;
  readonly tools?: readonly string[];
  readonly root: CompiledSequenceBlock;
  readonly operators: Readonly<Record<string, CompiledOperator>>;
  readonly contracts: Readonly<Record<string, CompiledContract>>;
  readonly inputEdges: Readonly<Record<string, readonly string[]>>;
  readonly digest: string;
}
