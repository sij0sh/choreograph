import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/runtime/artifact-store.ts";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newStore(runId = "run-1") {
  const root = mkdtempSync(join(tmpdir(), "pwf-store-"));
  roots.push(root);
  return { root, store: ArtifactStore.forRun(root, runId) };
}

test("forRun roots the store under the workflow's run directory and rejects relative directories", () => {
  const { root, store } = newStore("run-42");
  assert.equal(store.rootDir, join(root, ".choreograph", "runs", "run-42", "artifacts"));
  assert.equal(ArtifactStore.forRun("relative/workflow", "run-1"), undefined);
});

test("published text artifacts carry checksum, size, and media type and round-trip", () => {
  const { store } = newStore();
  const ref = store.publishText("stdout", "root/probe#1", "logged output");
  assert.equal(ref.invocationKey, "root/probe#1");
  assert.equal(ref.output, "stdout");
  assert.match(ref.checksum, /^sha256-[0-9a-f]{64}$/);
  assert.equal(ref.size, Buffer.byteLength("logged output"));
  assert.equal(ref.mediaType, "text/plain; charset=utf-8");
  assert.equal(readFileSync(store.pathOf(ref), "utf8"), "logged output");
  const loaded = store.load(ref);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.equal(loaded.content.toString("utf8"), "logged output");
});

test("published json artifacts store canonical JSON and load back as bytes", () => {
  const { store } = newStore();
  const value = { answer: 42, nested: { list: [1, 2, 3] } };
  const ref = store.publishJson("output", "root/emit#1", value);
  assert.equal(ref.mediaType, "application/json");
  assert.equal(ref.size, Buffer.byteLength(`${JSON.stringify(value)}\n`));
  const loaded = store.load(ref);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.deepEqual(JSON.parse(loaded.content.toString("utf8")), value);
});

test("content addressing dedupes identical payloads and separates different ones", () => {
  const { store } = newStore();
  const first = store.publishText("stdout", "root/a#1", "same bytes");
  const second = store.publishText("stdout", "root/b#1", "same bytes");
  const other = store.publishText("stdout", "root/a#1", "other bytes");
  assert.equal(first.checksum, second.checksum);
  assert.notEqual(first.checksum, other.checksum);
  assert.equal(readdirSync(join(store.rootDir, "objects")).length, 2);
});

test("load verifies the checksum and rejects corrupted or missing objects", () => {
  const { store } = newStore();
  const ref = store.publishText("output", "root/a#1", "trustworthy");
  const path = store.pathOf(ref);
  writeFileSync(path, "tampered");
  const corrupt = store.load(ref);
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.error, /does not match/);
  const missing = store.load({ ...ref, checksum: `sha256-${"0".repeat(64)}` });
  assert.equal(missing.ok, false);
  const malformed = store.load({ ...ref, checksum: "md5-abc" });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /sha-256/);
});

test("publishFile stores raw bytes with the octet-stream media type", () => {
  const { root, store } = newStore();
  const payloadPath = join(root, "payload.bin");
  writeFileSync(payloadPath, Buffer.from([0, 1, 2, 255]));
  const ref = store.publishFile("capture", "root/cap#1", payloadPath);
  assert.equal(ref.mediaType, "application/octet-stream");
  assert.equal(ref.size, 4);
  const loaded = store.load(ref);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.deepEqual([...loaded.content], [0, 1, 2, 255]);
});

test("sinkFor stamps invocation provenance onto every published ref", () => {
  const { store } = newStore();
  const sink = store.sinkFor("root/probe#1");
  const log = sink.publishText("stdout", "hi");
  const json = sink.publishJson("output", { ok: true });
  assert.equal(log.invocationKey, "root/probe#1");
  assert.equal(log.output, "stdout");
  assert.equal(json.invocationKey, "root/probe#1");
  assert.equal(json.output, "output");
});

test("materialize writes the artifact into the workspace and returns a relative path", () => {
  const { root, store } = newStore();
  const workspace = join(root, "workspace");
  const ref = store.publishJson("output", "root/emit#1", { answer: 42 });
  const done = store.materialize(ref, workspace);
  assert.ok(done.ok, done.ok ? "" : done.error);
  assert.equal(done.path, `.choreograph/artifacts/${ref.checksum.slice("sha256-".length)}`);
  const materialized = join(workspace, done.path);
  assert.ok(existsSync(materialized));
  assert.deepEqual(JSON.parse(readFileSync(materialized, "utf8")), { answer: 42 });
  const failed = store.materialize({ ...ref, checksum: `sha256-${"e".repeat(64)}` }, workspace);
  assert.equal(failed.ok, false);
});
