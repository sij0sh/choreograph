import type { Workflow } from "./workflow.ts";
import type { NodeSpec } from "./node.ts";

export interface CompiledWorkflow {
  readonly workflow: Workflow;
  readonly nodes: ReadonlyMap<string, NodeSpec>;
  readonly instructionDigests: ReadonlyMap<string, string>;
  readonly digest: string;
}
