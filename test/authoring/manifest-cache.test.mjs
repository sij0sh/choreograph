import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { discoverWorkflows, loadWorkflowManifest } from "../../src/authoring/parser.ts";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwf-cache-"));
  roots.push(root);
  return root;
}

function writeGoodWorkflow(root, name, description) {
  mkdirSync(join(root, name, "steps"), { recursive: true });
  mkdirSync(join(root, name, "contracts"), { recursive: true });
  writeFileSync(join(root, name, "WORKFLOW.md"), `---\ndescription: ${description}\nsteps:\n  - steps/a.md\n---\n`);
  writeFileSync(join(root, name, "steps", "a.md"), "# A");
  writeFileSync(
    join(root, name, "contracts", "check.schema.json"),
    JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }),
  );
}

const stripValidate = (workflow) => ({
  ...workflow,
  contracts: new Map([...workflow.contracts].map(([id, contract]) => [id, { id: contract.id, path: contract.path, schema: contract.schema }])),
});

const cachePathFor = (root) => join(root, ".workflow-manifest-cache.json");

test("warm cache serves data-identical workflows with working validators", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "alpha", "first");
  writeGoodWorkflow(root, "beta", "second");
  const cachePath = cachePathFor(root);

  const first = discoverWorkflows(root, cachePath);
  assert.deepEqual(first.diagnostics, []);
  assert.ok(existsSync(cachePath), "cache file is written after the first discovery");

  const second = discoverWorkflows(root, cachePath);
  assert.deepEqual(second.diagnostics, []);
  assert.deepEqual(second.workflows.map((workflow) => workflow.name), first.workflows.map((workflow) => workflow.name));
  for (let index = 0; index < first.workflows.length; index++) {
    assert.deepEqual(stripValidate(second.workflows[index]), stripValidate(first.workflows[index]));
  }

  const fresh = loadWorkflowManifest(join(root, "alpha"));
  for (const [id, contract] of second.workflows.find((workflow) => workflow.name === "alpha").contracts) {
    const reference = fresh.contracts.get(id);
    assert.deepEqual(contract.validate({ ok: true }), reference.validate({ ok: true }));
    assert.equal(contract.validate({}).length, reference.validate({}).length);
    assert.equal(contract.validate({ ok: "yes", extra: 1 }).length, reference.validate({ ok: "yes", extra: 1 }).length);
  }
});

test("a changed manifest is recompiled on the next discovery", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "alpha", "before");
  const cachePath = cachePathFor(root);
  discoverWorkflows(root, cachePath);

  writeFileSync(join(root, "alpha", "WORKFLOW.md"), `---\ndescription: after\nsteps:\n  - steps/a.md\n---\n`);
  const rediscovered = discoverWorkflows(root, cachePath);
  const alpha = rediscovered.workflows.find((workflow) => workflow.name === "alpha");
  assert.equal(alpha.description, "after");
  assert.equal(alpha.description, loadWorkflowManifest(join(root, "alpha")).description);
});

test("a corrupted cache file fails open and is rewritten", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "alpha", "first");
  writeGoodWorkflow(root, "beta", "second");
  const cachePath = cachePathFor(root);
  discoverWorkflows(root, cachePath);

  writeFileSync(cachePath, "{not json");
  const result = discoverWorkflows(root, cachePath);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.workflows.map((workflow) => workflow.name).sort(), ["alpha", "beta"]);

  const rewritten = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(rewritten.version, 1);
  assert.deepEqual(Object.keys(rewritten.entries).sort(), ["alpha", "beta"]);

  const warm = discoverWorkflows(root, cachePath);
  assert.deepEqual(warm.diagnostics, []);
  for (let index = 0; index < warm.workflows.length; index++) {
    assert.deepEqual(stripValidate(warm.workflows[index]), stripValidate(result.workflows[index]));
  }
});

test("invalid manifests stay diagnostic and are never cached", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "good", "ok");
  mkdirSync(join(root, "bad"));
  writeFileSync(join(root, "bad", "WORKFLOW.md"), `---\ndescription: bad\nsteps: []\n---\n`);
  const cachePath = cachePathFor(root);

  const first = discoverWorkflows(root, cachePath);
  assert.equal(first.diagnostics.length, 1);
  const second = discoverWorkflows(root, cachePath);
  assert.equal(second.diagnostics.length, 1);
  assert.equal(second.diagnostics[0].error, first.diagnostics[0].error);

  const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(parsed.entries.bad, undefined, "diagnostics are never cached");
  assert.ok(parsed.entries.good);
});

test("the cache file is never discovered as a workflow", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "alpha", "only");
  const cachePath = cachePathFor(root);
  const result = discoverWorkflows(root, cachePath);
  assert.deepEqual(result.workflows.map((workflow) => workflow.name), ["alpha"]);
  assert.ok(existsSync(cachePath));
  assert.ok(!result.workflows.some((workflow) => workflow.overviewPath === cachePath));
});

test("a cache entry whose paths escape the workflows root is not trusted", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "alpha", "honest");
  const cachePath = cachePathFor(root);
  discoverWorkflows(root, cachePath);

  const outside = join(mkdtempSync(join(tmpdir(), "pwf-escape-")), "outside.schema.json");
  roots.push(join(outside, ".."));
  writeFileSync(outside, "{}");
  const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  parsed.entries.alpha.workflow.contracts[0][1].path = outside;
  writeFileSync(cachePath, JSON.stringify(parsed));

  const result = discoverWorkflows(root, cachePath);
  const alpha = result.workflows.find((workflow) => workflow.name === "alpha");
  assert.ok(alpha, "the tampered entry is ignored and the workflow is recompiled");
  assert.match(alpha.contracts.get("check").path, /check\.schema\.json$/);

  const reparsed = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.match(reparsed.entries.alpha.workflow.contracts[0][1].path, /check\.schema\.json$/);
});

test("a cache hit whose instruction file disappeared is rejected and recompiled", () => {
  const root = newRoot();
  writeGoodWorkflow(root, "beta", "referenced");
  const cachePath = cachePathFor(root);
  discoverWorkflows(root, cachePath);

  unlinkSync(join(root, "beta", "steps", "a.md"));
  const broken = discoverWorkflows(root, cachePath);
  assert.equal(broken.diagnostics.length, 1);
  assert.match(broken.diagnostics[0].error, /not a readable file/);

  writeFileSync(join(root, "beta", "steps", "a.md"), "# A");
  const restored = discoverWorkflows(root, cachePath);
  assert.deepEqual(restored.diagnostics, []);
  assert.deepEqual(restored.workflows.map((workflow) => workflow.name), ["beta"]);
});
