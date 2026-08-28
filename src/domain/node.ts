import { resolve } from "node:path";
import type { InputBinding, ScriptSpec } from "./workflow.ts";

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

/** The agent-executable part of any position the runtime can dispatch. */
export interface AgentPositionSpec {
  readonly runner: "agent";
  readonly blockId: string;
}

/** A spec any registered runner can be asked to run; AgentNodeSpec is structurally assignable. */
export type RunnerSpec = AgentPositionSpec | ProcessNodeSpec;

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
  /** Content digest of the stored bytes, formatted as `sha256-<hex>`. */
  readonly checksum: string;
  /** Stored payload size in bytes. */
  readonly size: number;
  /** RFC 2045 media type of the stored bytes. */
  readonly mediaType: string;
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
