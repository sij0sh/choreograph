import type { NodeInvocation, RunnerSpec } from "../domain/node.ts";
import type { NodeResult, Runner, RunnerContext } from "./runner.ts";

export type RunnerKind = NodeInvocation["runner"];

/** A runner whose dispatches wait for an external completion signal, such as the agent settling a position. */
export interface AwaitingRunner extends Runner {
  settle(invocationKey: string, result: NodeResult): boolean;
}

export interface DispatchHandle {
  readonly invocation: NodeInvocation;
  readonly runner: Runner;
  readonly result: Promise<NodeResult>;
}

function isAwaiting(runner: Runner): runner is AwaitingRunner {
  return typeof (runner as Partial<AwaitingRunner>).settle === "function";
}

/**
 * Routes invocations to their runner and owns the runner-neutral dispatch
 * lifecycle: dispatch, await external completion, complete, and cancel.
 */
export class RunnerRegistry {
  private readonly runners = new Map<RunnerKind, Runner>();
  private readonly active = new Map<string, { readonly handle: DispatchHandle; readonly abort: AbortController }>();

  constructor(runners: readonly Runner[] = []) {
    for (const runner of runners) this.register(runner);
  }

  register(runner: Runner): this {
    this.runners.set(runner.kind, runner);
    return this;
  }

  runnerFor(kind: RunnerKind): Runner {
    const runner = this.runners.get(kind);
    if (!runner) throw new Error(`no runner registered for "${kind}" invocations`);
    return runner;
  }

  dispatch(invocation: NodeInvocation, spec: RunnerSpec, inputs?: RunnerContext["inputs"]): DispatchHandle {
    const existing = this.active.get(invocation.key);
    if (existing) return existing.handle;
    const runner = this.runnerFor(invocation.runner);
    const abort = new AbortController();
    const result = Promise.resolve(
      runner.execute(invocation, spec, { ...(inputs ? { inputs } : {}), signal: abort.signal }),
    );
    const handle: DispatchHandle = { invocation, runner, result };
    this.active.set(invocation.key, { handle, abort });
    const clear = (): void => {
      
      if (this.active.get(invocation.key)?.handle === handle) this.active.delete(invocation.key);
    };
    void result.then(clear, clear);
    return handle;
  }

  /** Completes an awaiting dispatch from outside, such as the agent's workflow_transition outcome. */
  complete(invocationKey: string, result: NodeResult): boolean {
    const entry = this.active.get(invocationKey);
    if (!entry || !isAwaiting(entry.handle.runner)) return false;
    const settled = entry.handle.runner.settle(invocationKey, result);
    if (settled) this.active.delete(invocationKey);
    return settled;
  }

  async cancel(invocationKey: string): Promise<boolean> {
    const entry = this.active.get(invocationKey);
    if (!entry) return false;
    entry.abort.abort();
    entry.handle.runner.cancel?.(entry.handle.invocation);
    await entry.handle.result.catch(() => {});
    this.active.delete(invocationKey);
    return true;
  }

  async cancelAll(): Promise<void> {
    for (const key of [...this.active.keys()]) await this.cancel(key);
  }

  activeInvocations(): readonly NodeInvocation[] {
    return [...this.active.values()].map((entry) => entry.handle.invocation);
  }
}
