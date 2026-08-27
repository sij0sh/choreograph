import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../../src/runtime/process-runner.ts";

const LONG = "setInterval(() => {}, 50)";

test("runs argv without a shell and captures stdout", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "process.stdout.write('plain output')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "plain output");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test("merges env exactly as given: no inherited variables beyond the allowlist", async () => {
  const result = await runProcess({
    argv: [process.execPath, "-e", "process.stdout.write(String(Object.keys(process.env).length) + ':' + String(process.env.MARKER))"],
    cwd: process.cwd(),
    env: { MARKER: "yes" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.stdout, "1:yes", "only the provided env entries are visible to the process");
});

test("kills the process on timeout and reports the timeout", async () => {
  const result = await runProcess({
    argv: ["node", "-e", LONG],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 1_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, undefined);
  assert.equal(result.signal, "SIGTERM");
});

test("truncates capture beyond maxCaptureBytes and flags it", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "process.stdout.write('x'.repeat(100))"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 16,
  });
  assert.equal(result.stdout.length, 16);
  assert.equal(result.truncated, true);
});

test("reports non-zero exit codes for acceptedExitCodes handling upstream", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "process.exit(3)"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
});

test("reports spawn failures as a failed process", async () => {
  const result = await runProcess({
    argv: ["/nonexistent-binary-xyz", "--flag"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.code, undefined);
  assert.match(result.stderr, /spawn failed/);
});

test("shell metacharacters are not interpreted", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "process.stdout.write('a')", "; touch /tmp/pwned-marker-never"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.stdout, "a", "the script runs with the raw extra argument, not through a shell");
  assert.equal(existsSync("/tmp/pwned-marker-never"), false, "no shell command executes");
});

test("respects the cwd", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "process.stdout.write(process.cwd().endsWith('test') ? 'in-test' : 'elsewhere')"],
    cwd: join("test"),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.stdout, "in-test");
});
