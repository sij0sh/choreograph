import { resolve } from "node:path";
import type { InputBinding, ScriptSpec } from "./workflow.ts";

export type RunnerKind = "agent" | "process";

export type InvocationStatus = "running" | "waiting" | "succeeded" | "failed" | "canceled" | "skipped";

/** What an agent runner needs to accept a dispatch; position details live in the workflow's task block. */
export interface AgentRunnerSpec {
  readonly runner: "agent";
  readonly blockId: string;
}

export interface ProcessRunnerSpec {
  readonly runner: "process";
  readonly blockId: string;
  readonly spec: ScriptSpec;
  readonly cwd: string;
  readonly containmentRoot?: string;
  readonly inputs?: Readonly<Record<string, InputBinding>>;
}

/** A spec any registered runner can be asked to run. */
export type RunnerSpec = AgentRunnerSpec | ProcessRunnerSpec;

export interface Invocation {
  readonly blockId: string;
  readonly key: string;
  readonly runner: RunnerKind;
  readonly status: InvocationStatus;
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

export function processSpecFor(script: ScriptSpec, blockId: string, workflowDir?: string): ProcessRunnerSpec {
  const cwd = workflowDir === undefined ? script.cwd : resolve(workflowDir, script.cwd);
  return {
    runner: "process",
    blockId,
    spec: script,
    cwd,
    ...(workflowDir === undefined ? {} : { containmentRoot: workflowDir }),
  };
}
