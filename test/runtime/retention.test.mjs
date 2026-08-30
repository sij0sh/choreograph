import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/runtime/artifact-store.ts";
import { sweepMaterializedArtifacts, sweepWorkflowArtifacts } from "../../src/runtime/retention.ts";
import { LIMITS } from "../../src/domain/limits.ts";
import { script, workflow } from "../engine/helpers.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "pwf-retention-"));
  roots.push(root);
  return root;
}

function artifactsDirUnder(base) {
  return join(base, ".choreograph", "artifacts");
}

function writeCopy(dir, name, bytes, ageMs = 0, now = Date.now()) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 0x61));
  if (ageMs > 0) utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
  return path;
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) total += statSync(join(dir, entry)).size;
  return total;
}

function hex(name) {
  return name.padEnd(64, "0");
}

function withBudget(bytes, run) {
  const previous = [LIMITS.materializeKeepBytes, LIMITS.materializeGraceMs];
  LIMITS.materializeKeepBytes = bytes;
  LIMITS.materializeGraceMs = 0;
  try {
    run();
  } finally {
    LIMITS.materializeKeepBytes = previous[0];
    LIMITS.materializeGraceMs = previous[1];
  }
}

test("materialize copies keep the newest bytes within the sweep budget and report evictions", () => {
  const dir = artifactsDirUnder(newWorkspace());
  const now = Date.now();
  writeCopy(dir, hex("a"), 600, 3_000, now);
  writeCopy(dir, hex("b"), 600, 2_000, now);
  writeCopy(dir, hex("c"), 600, 1_000, now);
  const outcome = sweepMaterializedArtifacts(dir, 1_500, 0, now);
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.evicted, [hex("a")]);
  assert.equal(outcome.evictedBytes, 600);
  assert.deepEqual(readdirSync(dir).sort(), [hex("b"), hex("c")]);
});

test("copies written within the mtime grace window are never evicted", () => {
  const dir = artifactsDirUnder(newWorkspace());
  const now = Date.now();
  writeCopy(dir, hex("fresh"), 2_000, 0, now);
  writeCopy(dir, hex("old"), 600, 10 * 60_000, now);
  const outcome = sweepMaterializedArtifacts(dir, 1_000, 60_000, now);
  assert.deepEqual(outcome.evicted, [hex("old")]);
  assert.equal(outcome.evictedBytes, 600);
  assert.ok(existsSync(join(dir, hex("fresh"))), "the fresh active-run copy survives even over budget");
});

test("a missing materialize directory sweeps nothing without warnings", () => {
  const dir = artifactsDirUnder(newWorkspace());
  const outcome = sweepMaterializedArtifacts(dir, 0, 0);
  assert.deepEqual(outcome.evicted, []);
  assert.equal(outcome.evictedBytes, 0);
  assert.equal(outcome.error, undefined);
});

test("evicted materialized copies re-materialize on demand and load back byte-identical", () => {
  const root = newWorkspace();
  const store = ArtifactStore.forRun(root, "run-1");
  const ref = store.publishText("stdout", "root/probe#1", "payload bytes");
  const scriptCwd = join(root, "scripts");
  const first = store.materialize(ref, scriptCwd);
  assert.ok(first.ok, first.ok ? "" : first.error);
  const dir = artifactsDirUnder(scriptCwd);
  const hexName = ref.checksum.slice("sha256-".length);
  const outcome = sweepMaterializedArtifacts(dir, 0, 0);
  assert.deepEqual(outcome.evicted, [hexName]);
  assert.ok(!existsSync(join(dir, hexName)), "the sweep removed the workspace copy");
  const second = store.materialize(ref, scriptCwd);
  assert.ok(second.ok, second.ok ? "" : second.error);
  assert.equal(second.path, first.path);
  const loaded = store.load(ref);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.equal(loaded.content.toString("utf8"), "payload bytes");
});

test("sweepWorkflowArtifacts sweeps the workflow root and each resolved script cwd", () => {
  const root = newWorkspace();
  mkdirSync(join(root, "scripts"), { recursive: true });
  const wf = workflow([script("probe", { spec: { cwd: "scripts" } })], { overviewPath: join(root, "WORKFLOW.md") });
  const rootDir = artifactsDirUnder(root);
  const scriptDir = artifactsDirUnder(join(root, "scripts"));
  writeCopy(rootDir, hex("root-copy"), 800, 60_000);
  writeCopy(scriptDir, hex("script-copy"), 800, 60_000);
  const notes = [];
  withBudget(500, () => {
    sweepWorkflowArtifacts([wf], undefined, "run-1", (message, level) => notes.push({ message, level }), wf);
  });
  const infos = notes.filter((note) => note.level === "info");
  assert.equal(infos.length, 2, `expected one eviction notice per swept dir, got ${JSON.stringify(notes)}`);
  for (const info of infos) {
    assert.match(info.message, /1 materialized artifact copy\(ies\) \(800 bytes\)/);
  }
  assert.deepEqual(readdirSync(rootDir), []);
  assert.deepEqual(readdirSync(scriptDir), []);
});

test("materialize sweep failures warn via notify and continue with the remaining dirs", () => {
  const root = newWorkspace();
  mkdirSync(join(root, ".choreograph"), { recursive: true });
  writeFileSync(join(root, ".choreograph", "artifacts"), "a file where the artifacts dir should be");
  mkdirSync(join(root, "scripts"), { recursive: true });
  const wf = workflow([script("probe", { spec: { cwd: "scripts" } })], { overviewPath: join(root, "WORKFLOW.md") });
  const scriptDir = artifactsDirUnder(join(root, "scripts"));
  writeCopy(scriptDir, hex("script-copy"), 800, 60_000);
  const notes = [];
  withBudget(500, () => {
    sweepWorkflowArtifacts([wf], undefined, undefined, (message, level) => notes.push({ message, level }), wf);
  });
  const warnings = notes.filter((note) => note.level === "warning");
  assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(notes)}`);
  assert.match(warnings[0].message, /stopped early in/);
  const infos = notes.filter((note) => note.level === "info");
  assert.equal(infos.length, 1, "the script-cwd dir is still swept after the root dir fails");
  assert.deepEqual(readdirSync(scriptDir), []);
});

test("50k-op churn plateaus at the byte budget with zero net growth in the tail", () => {
  const dir = artifactsDirUnder(newWorkspace());
  const budget = 4_096;
  const artifactBytes = 256;
  const sweepEvery = 50;
  const ops = 50_000;
  let evictedTotal = 0;
  let sawOverBudget = false;
  const tail = [];
  for (let op = 0; op < ops; op++) {
    writeCopy(dir, op.toString(16).padStart(64, "0"), artifactBytes);
    if (op % sweepEvery === sweepEvery - 1) {
      if (dirBytes(dir) > budget) sawOverBudget = true;
      // Sweep 1s ahead of wall time so freshly written copies are never graced
      // by sub-millisecond mtime precision (grace is 0 here), even under load.
      const outcome = sweepMaterializedArtifacts(dir, budget, 0, Date.now() + 1_000);
      evictedTotal += outcome.evicted.length;
      tail.push(dirBytes(dir));
      if (tail.length > 20) tail.shift();
    }
  }
  assert.ok(sawOverBudget, "the churn must exceed the budget between sweeps");
  assert.ok(evictedTotal > 0, "the sweep must evict during churn");
  assert.ok(tail.every((bytes) => bytes <= budget), `plateau broken: ${tail.join(
)}`);
  assert.ok(tail.every((bytes) => bytes > budget - 4 * artifactBytes), `plateau drifted below the budget: ${tail.join(
)}`);
});
