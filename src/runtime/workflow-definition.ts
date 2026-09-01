import { readFileSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import { freezeDefinition, type WorkflowDefinition } from "../authoring/compile.ts";
import { workflowBlocks, instructionFileOf, type Workflow } from "../domain/workflow.ts";
import { readBlockFrom } from "./prompts.ts";

/** A workflow definition failed strict compilation (for example, a required file is unreadable); the run must not start. */
export class WorkflowCompileError extends Error {
  readonly detail: string;

  constructor(workflow: Workflow, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot compile the definition of ${workflow.title}: ${detail}. The run did not start; restore the file or fix the definition, then start again.`, { cause });
    this.name = "WorkflowCompileError";
    this.detail = detail;
  }
}

const defaultRead = readBlockFrom({ statSync, readFileSync });

/** Reads the real filesystem strictly: a missing required file is undefined, never an error string. */
const strictRead = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Frozen prompt and definition sources for the active run. Prompt rendering
 * reads frozen copies instead of the live files, so a mid-run edit cannot
 * change behavior without a restart or a digest mismatch on resume.
 */
export class FrozenSources {
  private readonly cache = new Map<string, WorkflowDefinition>();
  private readonly prompts = new Map<string, string>();
  private readonly read: ReturnType<typeof readBlockFrom>;
  private readonly injectedReader: boolean;

  constructor(read?: ReturnType<typeof readBlockFrom>) {
    this.injectedReader = read !== undefined;
    this.read = read ?? defaultRead;
  }

  /** Bound arrow: prompt readers receive this method detached. */
  readonly promptRead = (path: string, label: string): string => this.prompts.get(path) ?? this.read(path, label);

  /** Freeze prompt sources for the active run. */
  freezePromptSources(workflow: Workflow): void {
    this.prompts.clear();
    const frozen = this.frozenFor(workflow);
    const dir = dirname(workflow.overviewPath);
    const set = (path: string): void => {
      const content = frozen.contents[relative(dir, path)];
      if (content !== undefined) this.prompts.set(path, content);
    };
    set(workflow.overviewPath);
    for (const operator of workflow.operators.values()) set(operator.path);
    for (const block of workflowBlocks(workflow)) {
      const instruction = instructionFileOf(block);
      if (instruction) set(instruction);
    }
  }

  /**
   * Freeze a workflow's definition lazily and memoize it. An unreadable
   * required file fails the freeze and refuses the run via WorkflowCompileError.
   */
  frozenFor(workflow: Workflow): WorkflowDefinition {
    const cached = this.cache.get(workflow.name);
    if (cached) return cached;
    const reader = this.injectedReader
      ? (path: string): string | undefined => this.read(path, "frozen definition")
      : strictRead;
    try {
      const frozen = freezeDefinition(workflow, reader);
      this.cache.set(workflow.name, frozen);
      return frozen;
    } catch (error) {
      throw new WorkflowCompileError(workflow, error);
    }
  }
}
