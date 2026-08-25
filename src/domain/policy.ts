export type RecoveryAction = "retry" | "invalidate" | "replan" | "block";

export interface RecoveryPolicy {
  readonly maxAttempts: number;
  readonly maxReplans: number;
  readonly strategy: readonly RecoveryAction[];
  readonly scope?: string;
}

export const DEFAULT_TASK_RECOVERY: RecoveryPolicy = {
  maxAttempts: 2,
  maxReplans: 2,
  strategy: ["retry", "block"],
};

export const DEFAULT_PLAN_RECOVERY: RecoveryPolicy = {
  maxAttempts: 2,
  maxReplans: 2,
  strategy: ["retry", "invalidate", "replan", "block"],
};

export function resolveRecovery(policy: RecoveryPolicy | undefined, defaults: RecoveryPolicy = DEFAULT_TASK_RECOVERY): RecoveryPolicy {
  if (!policy) return defaults;
  return {
    maxAttempts: policy.maxAttempts ?? defaults.maxAttempts,
    maxReplans: policy.maxReplans ?? defaults.maxReplans,
    strategy: policy.strategy ?? defaults.strategy,
    ...(policy.scope !== undefined ? { scope: policy.scope } : {}),
  };
}
