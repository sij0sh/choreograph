export const LIMITS = {
  workflowBytes: 128_000,
  instructionFileBytes: 128_000,
  checkpointSummaryBytes: 4_096,
  checkpointBytes: 16_384,
  targetBytes: 4_096,
  nodeResultBytes: 8_192,
  planBytes: 32_768,
  memoryBytes: 524_288,
  planNodes: 8,
  nodeAttempts: 2,
  jsonDepth: 8,
  checkpointListItems: 8,
  checkpointItemBytes: 512,
  planNodeObjectiveBytes: 512,
  planNodeListItems: 8,
  contractBytes: 65_536,
  contractsCount: 16,
  bindingInputs: 8,
  positionInputsBytes: 24_576,
  stackDepth: 24,
  advanceSteps: 10_000,
  scriptArgvItems: 64,
  scriptArgBytes: 4_096,
  scriptEnvEntries: 32,
  scriptEnvValueBytes: 4_096,
  scriptTimeoutMinMs: 1_000,
  scriptTimeoutMaxMs: 600_000,
  scriptExitCodes: 32,
  scriptCaptureMaxBytes: 1_048_576,
  scriptCaptureFiles: 4,
} as const;

export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const NAME_PATTERN = ID_PATTERN;
export const MAX_WORKFLOW_BYTES = LIMITS.workflowBytes;
export const MAX_INSTRUCTION_BYTES = LIMITS.instructionFileBytes;
