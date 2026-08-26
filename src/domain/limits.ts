export const LIMITS = {
  workflowBytes: 128_000,
  instructionFileBytes: 128_000,
  checkpointSummaryBytes: 4_096,
  checkpointBytes: 16_384,
  nodeResultBytes: 8_192,
  planBytes: 32_768,
  memoryBytes: 524_288,
  planNodes: 8,
  nodeAttempts: 2,
  replans: 2,
  jsonDepth: 8,
  checkpointListItems: 8,
  checkpointItemBytes: 512,
  planNodeObjectiveBytes: 512,
  planNodeListItems: 8,
  stackDepth: 24,
  advanceSteps: 10_000,
} as const;

export const PLAN_CREATE_ATTEMPT_MAX = LIMITS.nodeAttempts + LIMITS.replans;


export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MODEL_SELECTOR_PATTERN = /^[^/\s]+\/[^/\s]+$/;
export const NAME_PATTERN = ID_PATTERN;
export const MAX_WORKFLOW_BYTES = LIMITS.workflowBytes;
export const MAX_INSTRUCTION_BYTES = LIMITS.instructionFileBytes;
