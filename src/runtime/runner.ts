import type { NodeInvocation, NodeSpec } from "../domain/node.ts";
import type { JsonValue } from "../domain/json.ts";
import type { ScriptSpec } from "../domain/workflow.ts";
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
}

export interface Runner {
  readonly kind: NodeSpec["runner"];
  readonly retrySafety: "at-least-once" | "idempotent";
  execute(invocation: NodeInvocation, spec: NodeSpec, ctx: RunnerContext): Promise<NodeResult>;
  cancel?(invocation: NodeInvocation): void;
}

import type { ProcessNodeSpec } from "../domain/node.ts";

export class ProcessRunner implements Runner {
  readonly kind = "process" as const;
  readonly retrySafety = "at-least-once" as const;

  execute(invocation: NodeInvocation, spec: NodeSpec, ctx: RunnerContext): Promise<NodeResult> {
    if (spec.runner !== "process") return Promise.resolve({ status: "failed", reason: `ProcessRunner does not run ${spec.runner} specs` });
    const processSpec = spec as ProcessNodeSpec;
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

export class AgentRunner implements Runner {
  readonly kind = "agent" as const;
  readonly retrySafety = "idempotent" as const;

  async execute(_invocation: NodeInvocation, spec: NodeSpec, _ctx: RunnerContext): Promise<NodeResult> {
    if (spec.runner !== "agent") return { status: "failed", reason: `AgentRunner does not run ${spec.runner} specs` };
    return { status: "succeeded" };
  }
}

function stdinOf(inputs: Readonly<Record<string, JsonValue>> | undefined): { readonly ok: true; readonly payload?: string } | { readonly ok: false; readonly error: string } {
  if (!inputs || Object.keys(inputs).length === 0) return { ok: true };
  const text = `${JSON.stringify(inputs)}\n`;
  if (text.length > LIMITS.positionInputsBytes) {
    return { ok: false, error: `script inputs serialize to ${text.length} bytes, over the ${LIMITS.positionInputsBytes}-byte stdin budget` };
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

export function processEnvOf(spec: ScriptSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of spec.inheritEnv ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (spec.env) Object.assign(env, spec.env);
  return env;
}
