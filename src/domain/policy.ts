export interface RecoveryPolicy {
  readonly maxAttempts: number;
}

export const DEFAULT_RECOVERY: RecoveryPolicy = { maxAttempts: 2 };
