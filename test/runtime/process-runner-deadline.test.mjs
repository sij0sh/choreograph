import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../../src/runtime/process-runner.ts";

const spec = (overrides = {}) => ({
  argv: ["sh", "-c", "setsid sleep 30"],
  cwd: ".",
  env: { PATH: process.env.PATH ?? "" },
  timeoutMs: 300,
  maxCaptureBytes: 4096,
  ...overrides,
});

test("an escaped descendant cannot wedge settlement past a bounded deadline (corr-c17)", async () => {
  const started = Date.now();
  const result = await runProcess(spec());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 9_000, `runProcess settled in ${elapsed}ms; the deadline did not fire`);
  assert.equal(result.timedOut, true);
  assert.ok(
    result.deadlineNote !== undefined || result.code !== undefined,
    "the forced or drained settle reports why the pipes never closed",
  );
});

test("aborting a run whose escaped descendant holds the pipes still settles (corr-c17)", async () => {
  const controller = new AbortController();
  const pending = runProcess(spec({ timeoutMs: 60_000, signal: controller.signal }));
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 9_000, `abort settled in ${elapsed}ms`);
  assert.equal(result.cancelled, true);
});
