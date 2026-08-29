import type { NodeInvocation, NodeSpec, RunnerSpec } from "../domain/node.ts";
import type { JsonValue } from "../domain/json.ts";
import type { ScriptSpec } from "../domain/workflow.ts";
import type { Issue } from "../engine/interpreter.ts";
import { LIMITS } from "../domain/limits.ts";
import type { ProcessResult } from "./process-runner.ts";
import { runProcess } from "./process-runner.ts";

export interface RunnerContext {
  readonly signal?: AbortSignal;
  readonly inputs?: Readonly<Record<string, JsonValue>>;
}

export interface NodeResult {
  readonly status: "succeeded" | "failed" | "canceled";
  readonly reason?: string;
  readonly exit?: ProcessResult;
  
  readonly summary?: string;
  readonly data?: JsonValue;
  readonly met?: readonly string[];
  readonly issues?: readonly Issue[];
}

export interface Runner {
  readonly kind: NodeSpec["runner"];
  readonly retrySafety: "at-least-once" | "idempotent";
  execute(invocation: NodeInvocation, spec: RunnerSpec, ctx: RunnerContext): Promise<NodeResult>;
  cancel?(invocation: NodeInvocation): void;
}

export class ProcessRunner implements Runner {
  readonly kind = "process" as const;
  readonly retrySafety = "at-least-once" as const;

  execute(invocation: NodeInvocation, spec: RunnerSpec, ctx: RunnerContext): Promise<NodeResult> {
    if (spec.runner !== "process") return Promise.resolve({ status: "failed", reason: `ProcessRunner does not run ${spec.runner} specs` });
    const processSpec = spec;
    const payload = stdinOf(ctx.inputs);
    if (!payload.ok) return Promise.resolve({ status: "failed", reason: payload.error });
    return runProcess({
      argv: [...processSpec.spec.argv],
      cwd: processSpec.cwd,
      containmentRoot: processSpec.containmentRoot,
      env: processEnvOf(processSpec.spec),
      timeoutMs: processSpec.spec.timeoutMs,
      maxCaptureBytes: processSpec.spec.maxCaptureBytes,
      stdin: payload.payload,
      signal: ctx.signal,
    }).then((exit) => resultOf(exit));
  }
}

/**
 * Runs agent positions by awaiting their external completion. An agent settles
 * when the position transitions (workflow_transition) or the run aborts.
 */
export class AgentRunner implements Runner {
  readonly kind = "agent" as const;
  readonly retrySafety = "idempotent" as const;
  private readonly awaiting = new Map<string, { readonly result: Promise<NodeResult>; readonly resolve: (result: NodeResult) => void }>();

  execute(invocation: NodeInvocation, spec: RunnerSpec, _ctx: RunnerContext): Promise<NodeResult> {
    if (spec.runner !== "agent") return Promise.resolve({ status: "failed", reason: `AgentRunner does not run ${spec.runner} specs` });
    const existing = this.awaiting.get(invocation.key);
    if (existing) return existing.result;
    let resolve!: (result: NodeResult) => void;
    const result = new Promise<NodeResult>((settle) => {
      resolve = settle;
    });
    this.awaiting.set(invocation.key, { result, resolve });
    return result;
  }

  settle(invocationKey: string, result: NodeResult): boolean {
    const pending = this.awaiting.get(invocationKey);
    if (!pending) return false;
    this.awaiting.delete(invocationKey);
    pending.resolve(result);
    return true;
  }

  cancel(invocation: NodeInvocation): void {
    this.settle(invocation.key, { status: "canceled" });
  }
}

function stdinOf(inputs: Readonly<Record<string, JsonValue>> | undefined): { readonly ok: true; readonly payload?: string } | { readonly ok: false; readonly error: string } {
  if (!inputs || Object.keys(inputs).length === 0) return { ok: true };
  const text = `${JSON.stringify(inputs)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > LIMITS.positionInputsBytes) {
    return { ok: false, error: `script inputs serialize to ${bytes} bytes, over the ${LIMITS.positionInputsBytes}-byte stdin budget` };
  }
  return { ok: true, payload: text };
}

function resultOf(exit: ProcessResult): NodeResult {
  if (exit.cancelled) return { status: "canceled", exit };
  if (exit.timedOut) return { status: "failed", reason: "timed out", exit };
  if (exit.spawnError !== undefined) return { status: "failed", reason: exit.spawnError, exit };
  if (exit.code === undefined) return { status: "failed", reason: `terminated by signal ${exit.signal ?? "unknown"}`, exit };
  return { status: exit.code === 0 ? "succeeded" : "failed", reason: exit.code === 0 ? undefined : `exited with code ${exit.code}`, exit };
}

function processEnvOf(spec: ScriptSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of spec.inheritEnv ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (spec.env) Object.assign(env, spec.env);
  return env;
}
