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
  positionSummaryBytes: 8_192,
  // Settle-guard nudges before a run is declared stalled: an agent position
  // settles only on transition or abort; a reply that ends without either gets
  // this many reminders to call workflow_transition before the user must step in.
  settleNudges: 3,
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
  // Stat-before-read budget for whole-file capture publishes (parity with the streamed cap).
  // Oversize captures fail deterministically at publish/load/materialize/inline instead of
  // buffering unbounded bytes on the host event loop.
  scriptCaptureFileBytes: 1_048_576,
  // Retention sweep at session/run start: evict oldest run dirs beyond these bounds
  // (never the active run) so <workflowDir>/.choreograph/runs/ cannot grow without bound.
  runArtifactsKeepRuns: 20,
  runArtifactsKeepBytes: 268_435_456,
  // Active-run markers older than this are stale: the run that wrote them died
  // without a terminal release (crash). The sweep never auto-evicts marked dirs;
  // it warns so the operator can reclaim them manually.
  activeMarkerGraceMs: 604_800_000,
  // Materialize-copy retention: scripts consume copies from <cwd>/.choreograph/artifacts/
  // and evicted copies re-materialize on demand, so the newest bytes within this budget
  // are kept and older copies are swept at the session/run-start cadence.
  materializeKeepBytes: 67_108_864,
  // Copies written within this window are never evicted: a script dispatched with the
  // copy as input may still be reading it (bounded by the max script timeout).
  materializeGraceMs: 600_000,
  // Snapshot commits per session; rollover-capable hosts roll to a fresh child session,
  // embedders pause the run, so per-session files stay bounded.
  snapshotEntriesPerSession: 256,
  // Serialized snapshot payload bytes per session (same rollover/pause split). 16 MiB
  // binds the measured runaway region (P~120 at 1 KiB states, audit probe c5) without
  // binding healthy summary-only runs earlier than the entry cap (node-5 measurement).
  snapshotBytesPerSession: 16_777_216,
  scriptCaptureFiles: 4,
} as const;

export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const NAME_PATTERN = ID_PATTERN;
export const MAX_WORKFLOW_BYTES = LIMITS.workflowBytes;
export const MAX_INSTRUCTION_BYTES = LIMITS.instructionFileBytes;
