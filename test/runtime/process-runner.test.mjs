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

test("writes the stdin payload to the child and closes the stream", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "let b=''; process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => process.stdout.write('got:' + b.trim()))"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
    stdin: '{"id":7}\n',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "got:{\"id\":7}");
});

test("a child that never reads stdin still completes", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "process.stdout.write('ignored input')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
    stdin: '{"unused":true}\n',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ignored input");
  assert.equal(result.timedOut, false);
});

test("no stdin payload leaves the child stdin empty at EOF", async () => {
  const result = await runProcess({
    argv: ["node", "-e", "let b=''; process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => process.stdout.write('dry:' + b.length))"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "dry:0");
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

test("an already-aborted signal skips spawning and reports cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess({
    argv: [process.execPath, "-e", "process.stdout.write('never')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.stdout, "");
  assert.equal(result.timedOut, false);
});

test("aborting mid-flight kills the child and reports cancelled", async () => {
  const controller = new AbortController();
  const pending = runProcess({
    argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 60_000,
    maxCaptureBytes: 65_536,
    signal: controller.signal,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true, "the result carries the cancelled flag");
  assert.equal(result.code, undefined, "the child was killed, not exited");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, false);
});

test("rejects a cwd that resolves outside the containment root", async (t) => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pwf-contain-"));
  const outside = mkdtempSync(join(tmpdir(), "pwf-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const escape = join(root, "escape");
  mkdirSync(escape);
  symlinkSync(outside, join(escape, "loop"));
  const result = await runProcess({
    argv: [process.execPath, "-e", "process.stdout.write('escaped')"],
    cwd: join(escape, "loop"),
    containmentRoot: root,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxCaptureBytes: 65_536,
  });
  assert.equal(result.code, undefined, "no process was spawned");
  assert.match(result.spawnError ?? "", /outside the workflow directory/);
});

test("allows a cwd inside the containment root, including the root itself", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pwf-contain-ok-"));
  try {
    const result = await runProcess({
      argv: [process.execPath, "-e", "process.stdout.write('inside')"],
      cwd: root,
      containmentRoot: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      maxCaptureBytes: 65_536,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "inside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout kills the whole process group, not just the direct child", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const markerArgv = [
    process.execPath,
    "-e",
    [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setInterval(() => {}, 60_000);",
    ].join(""),
  ];
  const pending = runProcess({
    argv: markerArgv,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 1_000,
    maxCaptureBytes: 65_536,
  });
  const result = await pending;
  assert.equal(result.timedOut, true);
  const grandchild = Number(result.stdout.trim());
  assert.ok(grandchild > 0, "the script reported its grandchild pid");
  let alive = true;
  try {
    execFileSync("kill", ["-0", String(grandchild)], { stdio: "ignore" });
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the grandchild in the same process group died with the leader");
});
