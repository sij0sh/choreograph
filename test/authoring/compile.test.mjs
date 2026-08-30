import test from "node:test";
import assert from "node:assert/strict";
import { freezeDefinition } from "../../src/authoring/compile.ts";
import { loop, script, task, workflow } from "../engine/helpers.mjs";

const CONTENT = "same content";
const READ_OK = () => CONTENT;
const freezeAt = (children, options = {}, read = READ_OK) =>
  freezeDefinition(workflow(children, options), read);
const operatorsOf = (...operators) => new Map(operators.map((entry) => [entry.id, entry]));
const operator = (id, extra = {}) => ({ id, path: `operators/${id}.md`, description: `${id} does things`, ...extra });
const plan = (id, operators) => ({ kind: "plan", id, operators });

test("freezeDefinition embeds every prompt source under its original path", () => {
  const frozen = freezeAt(
    [task("frame"), script("probe"), plan("make", ["inspect"]), loop("scan")],
    { operators: operatorsOf(operator("inspect")) },
  );
  assert.deepEqual(Object.keys(frozen.contents).sort(), [
    "WORKFLOW.md",
    "operators/inspect.md",
    "steps/frame.md",
    "steps/scan-step.md",
  ]);
  for (const content of Object.values(frozen.contents)) assert.equal(content, CONTENT);
  assert.match(frozen.digest, /^[0-9a-f]{64}$/);
});

test("the same definition freezes to the same digest", () => {
  const first = freezeAt([task("frame"), task("deliver")]);
  const second = freezeAt([task("frame"), task("deliver")]);
  assert.equal(first.digest, second.digest);
});

test("frozen instruction contents are embedded, so a later file edit changes the digest", () => {
  let content = "v1";
  const read = () => content;
  const first = freezeAt([task("frame")], {}, read);
  content = "v2";
  const second = freezeAt([task("frame")], {}, read);
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.contents["steps/frame.md"], "v1");
  assert.equal(second.contents["steps/frame.md"], "v2");
});

test("unreadable required files fail the freeze", () => {
  const withoutSteps = (path) => (path.includes("steps/") ? undefined : CONTENT);
  const withoutOperators = (path) => (path.includes("operators/") ? undefined : CONTENT);
  const withoutOverview = (path) => (path.endsWith("WORKFLOW.md") ? undefined : CONTENT);
  assert.throws(() => freezeAt([task("frame"), task("deliver")], {}, withoutSteps), /task frame instruction file/);
  assert.throws(() => freezeAt([plan("make", ["inspect"])], { operators: operatorsOf(operator("inspect")) }, withoutOperators), /operator inspect file/);
  assert.throws(() => freezeAt([task("frame")], {}, withoutOverview), /workflow overview file/);
});

test("the digest reacts to every change class", () => {
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
    assert.notEqual(freezeAt(left).digest, freezeAt(right).digest, `digest changes when ${label} changes`);
  }
  for (const [label, left, right] of optionPairs) {
    assert.notEqual(freezeAt([task("a")], left).digest, freezeAt([task("a")], right).digest, `digest changes when ${label} changes`);
  }
  const withContract = (schema) => [task("frame", { output: "result" })];
  assert.notEqual(
    freezeAt(withContract(), { contracts: { result: { type: "object" } } }).digest,
    freezeAt(withContract(), { contracts: { result: { type: "string" } } }).digest,
    "digest changes when a contract schema changes",
  );
  const withPlan = (operators) => [plan("make", ["inspect"])];
  const operatorRead = (content) => (path) => (path.includes("operators/") ? content : CONTENT);
  assert.notEqual(
    freezeAt(withPlan(), { operators: operatorsOf(operator("inspect", { description: "one" })) }).digest,
    freezeAt(withPlan(), { operators: operatorsOf(operator("inspect", { description: "two" })) }).digest,
    "digest changes when an operator description changes",
  );
  assert.notEqual(
    freezeAt(withPlan(), { operators: operatorsOf(operator("inspect", { tools: ["read"] })) }).digest,
    freezeAt(withPlan(), { operators: operatorsOf(operator("inspect")) }).digest,
    "digest changes when operator tools change",
  );
  assert.notEqual(
    freezeAt(withPlan(), { operators: operatorsOf(operator("inspect")) }, operatorRead("v1")).digest,
    freezeAt(withPlan(), { operators: operatorsOf(operator("inspect")) }, operatorRead("v2")).digest,
    "digest changes when operator content changes",
  );
  const overviewRead = (content) => (path) => (path.endsWith("WORKFLOW.md") ? content : CONTENT);
  assert.notEqual(
    freezeAt([task("a")], {}, overviewRead("v1")).digest,
    freezeAt([task("a")], {}, overviewRead("v2")).digest,
    "digest changes when the overview changes",
  );
});
