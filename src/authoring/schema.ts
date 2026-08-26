import { ID_PATTERN, LIMITS } from "../domain/limits.ts";
import { isValidJsonPointer, objectAt, requireString } from "../domain/json.ts";
import { DEFAULT_PLAN_RECOVERY, DEFAULT_TASK_RECOVERY, type RecoveryAction, type RecoveryPolicy } from "../domain/policy.ts";
import type { InputBinding } from "../domain/workflow.ts";

export const FRONTMATTER_KEYS = ["description", "steps", "piVisibility", "legalTools", "contracts"] as const;
export const STEP_KEYS = ["id", "run", "tools", "done", "repair", "plan", "inputs", "output"] as const;
export const OPERATOR_KEYS = ["description", "tools", "output"] as const;
const RECOVERY_KEYS = ["max_attempts", "max_replans", "strategy", "scope"] as const;
const RECOVERY_ACTIONS: readonly RecoveryAction[] = ["retry", "invalidate", "replan", "block"];
const VARIABLE_PATTERN = /^[a-z][a-z0-9_-]*$/;

export { MAX_WORKFLOW_BYTES, MAX_INSTRUCTION_BYTES, NAME_PATTERN } from "../domain/limits.ts";
export { VARIABLE_PATTERN };

export function stringAt(value: unknown, label: string): string {
  return requireString(value, label).trim();
}

export function booleanAt(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

export function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`unknown ${label} key: ${key}`);
}

function matchesToolName(tool: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(tool);
}

export function parseToolList(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${label} must be a list`);
  const tools = raw.map((value, index) => {
    const tool = stringAt(value, `${label}[${index}]`);
    if (!matchesToolName(tool)) throw new Error(`${label}[${index}] must match ^[a-z][a-z0-9_]*$`);
    return tool;
  });
  assertUnique(tools, label);
  return tools;
}

export function parseIdList(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} must be a non-empty list`);
  const ids = raw.map((value, index) => {
    const id = stringAt(value, `${label}[${index}]`);
    if (!ID_PATTERN.test(id)) throw new Error(`${label}[${index}] must match ^[a-z][a-z0-9-]*$`);
    return id;
  });
  assertUnique(ids, label);
  return ids;
}

export function parseInputBindings(raw: unknown, label: string): Record<string, InputBinding> | undefined {
  if (raw === undefined) return undefined;
  const body = objectAt(raw, label);
  const keys = Object.keys(body);
  if (keys.length === 0) throw new Error(`${label} must not be empty`);
  if (keys.length > LIMITS.bindingInputs) throw new Error(`${label} must have at most ${LIMITS.bindingInputs} entries`);
  const bindings: Record<string, InputBinding> = {};
  for (const name of keys) {
    if (!ID_PATTERN.test(name)) throw new Error(`${label}.${name} must match ^[a-z][a-z0-9-]*$`);
    const entry = objectAt(body[name], `${label}.${name}`);
    const keysOf = Object.keys(entry);
    for (const key of keysOf) {
      if (key !== "from" && key !== "select") throw new Error(`${label}.${name}.${key} is not an accepted binding field`);
    }
    const from = stringAt(entry.from, `${label}.${name}.from`);
    if (!ID_PATTERN.test(from)) throw new Error(`${label}.${name}.from must match ^[a-z][a-z0-9-]*$`);
    let select: string | undefined;
    if (entry.select !== undefined) {
      if (typeof entry.select !== "string") throw new Error(`${label}.${name}.select must be a JSON Pointer such as /nodes/0/id`);
      select = entry.select;
      if (!isValidJsonPointer(select)) throw new Error(`${label}.${name}.select must be a JSON Pointer such as /nodes/0/id`);
    }
    bindings[name] = select === undefined ? { from } : { from, select };
  }
  return bindings;
}

export function parseRecovery(raw: unknown, label: string, defaults: RecoveryPolicy = DEFAULT_TASK_RECOVERY): RecoveryPolicy | undefined {
  if (raw === undefined) return undefined;
  const body = objectAt(raw, label);
  assertKeys(body, RECOVERY_KEYS, label);
  const maxAttempts = body.max_attempts === undefined ? undefined : positiveIntAt(body.max_attempts, `${label}.max_attempts`, LIMITS.nodeAttempts + 1);
  const maxReplans = body.max_replans === undefined ? undefined : positiveIntAt(body.max_replans, `${label}.max_replans`, LIMITS.replans);
  let strategy: readonly RecoveryAction[] | undefined;
  if (body.strategy !== undefined) {
    if (!Array.isArray(body.strategy) || body.strategy.length === 0) throw new Error(`${label}.strategy must be a non-empty list`);
    strategy = body.strategy.map((value, index) => {
      const action = stringAt(value, `${label}.strategy[${index}]`);
      if (!RECOVERY_ACTIONS.includes(action as RecoveryAction)) throw new Error(`${label}.strategy[${index}] must be one of: ${RECOVERY_ACTIONS.join(", ")}`);
      return action as RecoveryAction;
    });
  }
  const scope = body.scope === undefined ? undefined : stringAt(body.scope, `${label}.scope`);
  if (scope !== undefined && !ID_PATTERN.test(scope)) throw new Error(`${label}.scope must match ^[a-z][a-z0-9-]*$`);
  return {
    maxAttempts: maxAttempts ?? defaults.maxAttempts,
    maxReplans: maxReplans ?? defaults.maxReplans,
    strategy: strategy ?? defaults.strategy,
    ...(scope !== undefined ? { scope } : {}),
  };
}

export function positiveIntAt(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}
