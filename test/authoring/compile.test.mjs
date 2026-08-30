import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileWorkflow } from "../../src/authoring/compile.ts";
import { canonicalJson } from "../../src/domain/json.ts";
import { loop, script, task, workflow } from "../engine/helpers.mjs";

const CONTENT = "same content";
const READ_OK = () => CONTENT;
const sha = (content) => createHash("sha256").update(content).digest("hex");
const compileAt = (children, options = {}, read = READ_OK, dir = "/tmp/x") =>
  compileWorkflow(workflow(children, options), read, dir);
const operatorsOf = (...operators) => new Map(operators.map((entry) => [entry.id, entry]));
const operator = (id, extra = {}) => ({ id, path: `/tmp/x/operators/${id}.md`, description: `${id} does things`, ...extra });
const plan = (id, operators) => ({ kind: "plan", id, operators });

test("compileWorkflow produces a stable digest independent of the workflow location", () => {
  const children = [task("frame"), task("deliver")];
  const first = compileAt(children, {}, READ_OK, "/tmp/one");
  const second = compileAt(children, {}, READ_OK, "/tmp/other");
  assert.equal(first.digest, second.digest, "only workflow-relative paths and content shape the digest");
  assert.match(first.digest, /^[0-9a-f]{64}$/);
});

test("the compiled definition is complete, versioned, and deeply frozen", () => {
  const compiled = compileAt(
    [
      task("frame", { tools: ["read"], done: ["framed"], output: "frame-result", guard: { from: "root", op: "exists" } }),
      script("probe"),
      plan("make", ["inspect"]),
      loop("scan"),
    ],
    {
      tools: ["read", "edit"],
      operators: operatorsOf(operator("inspect", { tools: ["read"], output: "looked" })),
      contracts: { "frame-result": { type: "object" } },
      inputEdges: { probe: ["frame"] },
    },
  );
  assert.equal(compiled.formatVersion, 2);
  const frozen = [
    compiled, compiled.root, compiled.root.children[0], compiled.root.children[0].instruction,
    compiled.root.children[1].script, compiled.root.children[2], compiled.root.children[3],
    compiled.operators, compiled.operators.inspect, compiled.operators.inspect.content,
    compiled.contracts, compiled.contracts["frame-result"].schema, compiled.inputEdges,
  ];
  for (const value of frozen) assert.ok(Object.isFrozen(value), "every compiled structure is frozen");
  assert.deepEqual(compiled.operators.inspect.content, { path: "operators/inspect.md", sha256: sha(CONTENT), content: CONTENT });
  assert.equal(compiled.operators.inspect.script, undefined, "model operators compile without a script");
  assert.equal(compiled.root.children[1].script.cwd, ".", "script specs keep their definition-relative cwd");
  assert.deepEqual(compiled.inputEdges, { probe: ["frame"] });
});

test("the digest is exactly the canonical hash of the compiled body", () => {
  const compiled = compileAt([task("frame")]);
  const { digest, ...body } = compiled;
  assert.equal(digest, createHash("sha256").update(canonicalJson(body)).digest("hex"));
});

test("instruction contents are embedded and hashed, not left as live file references", () => {
  let content = "v1";
  const read = () => content;
  const first = compileAt([task("frame")], {}, read);
  content = "v2";
  const second = compileAt([task("frame")], {}, read);
  assert.notEqual(first.digest, second.digest);
  assert.equal(second.root.children[0].instruction.content, "v2");
  assert.equal(second.root.children[0].instruction.sha256, sha("v2"));
});

test("unreadable required files fail compilation", () => {
  const withoutSteps = (path) => (path.includes("steps/") ? undefined : CONTENT);
  const withoutOperators = (path) => (path.includes("operators/") ? undefined : CONTENT);
  const withoutOverview = (path) => (path.endsWith("WORKFLOW.md") ? undefined : CONTENT);
  assert.throws(() => compileAt([task("frame"), task("deliver")], {}, withoutSteps), /task frame instruction file/);
  assert.throws(() => compileAt([plan("make", ["inspect"])], { operators: operatorsOf(operator("inspect")) }, withoutOperators), /operator inspect file/);
  assert.throws(() => compileAt([task("frame")], {}, withoutOverview), /workflow overview file/);
});

test("the digest reacts to every change class the old digest ignored", () => {
  const scriptTask = script("probe");
  const loopPlain = loop("scan");
  const loopTight = loop("scan", { maxIterations: 3 });
  const loopOtherBody = loop("scan", { body: { done: ["x"] } });
  const pairs = [
    ["script command", [script("probe", { spec: { argv: ["node", "-e", "2"] } })], [scriptTask]],
    ["script env", [script("probe", { spec: { env: { KEY: "v" } } })], [scriptTask]],
    ["script timeout", [script("probe", { spec: { timeoutMs: 1 } })], [scriptTask]],
    ["loop maxIterations", [loopTight], [loopPlain]],
    ["loop body", [loopOtherBody], [loopPlain]],
    ["plan operators", [plan("make", ["a", "b"])], [plan("make", ["a"])]],
    ["guard op", [task("second", { guard: { from: "first", op: "exists" } }), task("first")], [task("second", { guard: { from: "first", op: "not-exists" } }), task("first")]],
    ["recovery", [task("frame", { recovery: { maxAttempts: 5 } })], [task("frame")]],
    ["input binding select", [task("second", { inputs: { x: { from: "first", select: "/a" } } }), task("first")], [task("second", { inputs: { x: { from: "first" } } }), task("first")]],
    ["done criteria", [task("deliver", { done: ["d"] })], [task("deliver")]],
    ["step order", [task("a"), task("b")], [task("b"), task("a")]],
  ];
  const optionPairs = [
    ["workflow tool ceiling", { tools: ["read"] }, {}],
    ["title", { title: "One" }, { title: "Two" }],
    ["description", { description: "one" }, { description: "two" }],
    ["pi visibility", { piVisibility: true }, {}],
  ];
  for (const [label, left, right] of pairs) {
    assert.notEqual(compileAt(left).digest, compileAt(right).digest, `digest changes when ${label} changes`);
  }
  for (const [label, left, right] of optionPairs) {
    assert.notEqual(compileAt([task("a")], left).digest, compileAt([task("a")], right).digest, `digest changes when ${label} changes`);
  }
  const withContract = (schema) => [task("frame", { output: "result" })];
  assert.notEqual(
    compileAt(withContract(), { contracts: { result: { type: "object" } } }).digest,
    compileAt(withContract(), { contracts: { result: { type: "string" } } }).digest,
    "digest changes when a contract schema changes",
  );
  const withPlan = (operators) => [plan("make", ["inspect"])];
  const operatorRead = (content) => (path) => (path.includes("operators/") ? content : CONTENT);
  assert.notEqual(
    compileAt(withPlan(), { operators: operatorsOf(operator("inspect", { description: "one" })) }).digest,
    compileAt(withPlan(), { operators: operatorsOf(operator("inspect", { description: "two" })) }).digest,
    "digest changes when an operator description changes",
  );
  assert.notEqual(
    compileAt(withPlan(), { operators: operatorsOf(operator("inspect", { tools: ["read"] })) }).digest,
    compileAt(withPlan(), { operators: operatorsOf(operator("inspect")) }).digest,
    "digest changes when operator tools change",
  );
  assert.notEqual(
    compileAt(withPlan(), { operators: operatorsOf(operator("inspect")) }, operatorRead("v1")).digest,
    compileAt(withPlan(), { operators: operatorsOf(operator("inspect")) }, operatorRead("v2")).digest,
    "digest changes when operator content changes",
  );
  const overviewRead = (content) => (path) => (path.endsWith("WORKFLOW.md") ? content : CONTENT);
  assert.notEqual(
    compileAt([task("a")], {}, overviewRead("v1")).digest,
    compileAt([task("a")], {}, overviewRead("v2")).digest,
    "digest changes when the overview changes",
  );
});
