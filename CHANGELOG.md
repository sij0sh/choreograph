# Changelog

Notable behavior changes to choreograph, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
behavioral and reference the commits that introduced them.

## [0.1.5] - 2026-08-29

### Removed

- The cross-session workflow manifest cache introduced earlier in this
  tranche (c22872d), including its `WORKFLOW.md`-only digest trust rule.
  Discovery re-parses every workflow from disk; there is no cache digest
  and no cross-session decode path.

## [0.1.1] - 2026-08-28

Current tranche, starting at the `pre-pivot-cutover` tag (81dce51,
2026-08-25). History before that tag predates the choreograph rename and
the current architecture; it is not backfilled here.

### Changed

- Snapshots are written in format v5, with node results folded into
  checkpoints (f52a1d4). The codec writes v5 only; snapshots in earlier
  formats fail load-time validation instead of being migrated.
- Authoring accepts ordered sequences, dynamic plans, guards, and bounded
  loops only. choreograph dropped loop, branch, predicate, and reference
  authoring constructs (a398b21) and replaced per-position model selection
  with checkpoint ordering (eb6f4cc).
- `legalTools` is the canonical ceiling key for a position's tool access
  (be76fbe).
- Each position runs in an isolated LLM context with a persisted baseline
  tool set (575bba8).
- The extension is renamed to choreograph; pre-rename snapshots stay
  readable (66590e9).

### Added

- A cross-session workflow manifest cache with validator rehydration
  (c22872d). Trust rule: a cache entry is used only when its stored digest
  matches a fresh digest of `WORKFLOW.md` (c22872d), and cached workflows
  decode in the parser's key order (c9e68b). The digest covers
  `WORKFLOW.md` only.
- A retry precondition: `workflow_retry` is rejected while a process leaf
  is in flight (e5cf455).

### Fixed

- Workflow tool discovery across reloads (6a13dca), restore-time plan
  re-validation and repeat-attempt totals (70f0e64), and enforcement of the
  persisted-memory bound on transitions (c64bba9).
