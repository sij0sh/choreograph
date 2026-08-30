import test from "node:test";
import assert from "node:assert/strict";
import { validateDynamicPlan } from "../../src/planning/validate.ts";
import { firstIncompleteNode } from "../../src/planning/graph.ts";

const OPERATORS = new Map([
  ["inspect", { id: "inspect", path: "operators/inspect.md", description: "Inspect code." }],
  ["trace", { id: "trace", path: "operators/trace.md", description: "Trace flow." }],
]);

function node(id, operator = "inspect", extra = {}) {
  return { id, operator, objective: `Do ${id}`, done: [`${id}-done`], ...extra };
}

function validate(value, options = {}) {
  return validateDynamicPlan(value, {
    operators: OPERATORS,
    allowedOperators: options.allowed ?? ["inspect", "trace"],
  });
}

test("a valid plan passes", () => {
  const result = validate({ version: 1, nodes: [node("probe"), node("map", "trace", { dependsOn: ["probe"] })] });
  assert.deepEqual(result, { plan: { version: 1, nodes: [node("probe"), node("map", "trace", { dependsOn: ["probe"] })] } });
});

test("plans reject unknown fields, bad versions, and size bounds", () => {
  assert.ok("errors" in validate({ version: 2, nodes: [node("a"), node("b")] }));
  assert.ok("errors" in validate({ version: 1, tools: [], nodes: [node("a"), node("b")] }));
  assert.ok("errors" in validate({ version: 1, nodes: [node("a", "inspect", { tools: ["bash"] })] }));
  assert.ok("errors" in validate({ version: 1, nodes: [node("a")] }));
  assert.ok("errors" in validate({ version: 1, nodes: Array.from({ length: 9 }, (_, i) => node(`n${i}`)) }));
});

test("nodes must use the block's trusted operators", () => {
  const result = validate({ version: 1, nodes: [node("a"), node("b", "trace")] }, { allowed: ["inspect"] });
  assert.ok("errors" in result);
  assert.ok(result.errors.some((error) => /trusted operators/.test(error)));
});

test("dependencies must name earlier nodes", () => {
  const forward = validate({ version: 1, nodes: [node("a", "inspect", { dependsOn: ["b"] }), node("b")] });
  assert.ok("errors" in forward);
  const self = validate({ version: 1, nodes: [node("a", "inspect", { dependsOn: ["a"] }), node("b")] });
  assert.ok("errors" in self);
});


test("firstIncompleteNode finds the first node without a result", () => {
  const execution = {
    blockId: "investigate",
    plan: { version: 1, nodes: [node("a"), node("b"), node("c")] },
    results: { a: { summary: "done" }, c: { summary: "done" } },
  };
  assert.equal(firstIncompleteNode(execution).id, "b");
  const finished = { ...execution, results: { a: { summary: "" }, b: { summary: "" }, c: { summary: "" } } };
  assert.equal(firstIncompleteNode(finished), undefined);
});

test("process operator nodes take neither done nor evidence", () => {
  const operators = new Map([
    ...OPERATORS,
    ["fetch", { id: "fetch", path: "operators/fetch.md", description: "Fetch.", script: { argv: ["node", "fetch.mjs"], cwd: ".", timeoutMs: 1_000, acceptedExitCodes: [0], stdout: "json", stderr: "none", maxCaptureBytes: 1_024 } }],
  ]);
  const validateWith = (value) =>
    validateDynamicPlan(value, { operators, allowedOperators: ["inspect", "trace", "fetch"] });
  const good = validateWith({ version: 1, nodes: [node("probe"), { id: "fetch-data", operator: "fetch", objective: "Fetch.", dependsOn: ["probe"] }] });
  assert.ok("plan" in good);
  assert.deepEqual(good.plan.nodes[1].done, []);
  const withDone = validateWith({ version: 1, nodes: [node("probe"), { id: "fetch-data", operator: "fetch", objective: "Fetch.", done: ["fetched"] }] });
  assert.ok("errors" in withDone);
  assert.ok(withDone.errors.some((error) => /neither "done" nor "evidence"/.test(error)));
  const withEvidence = validateWith({ version: 1, nodes: [node("probe"), { id: "fetch-data", operator: "fetch", objective: "Fetch.", evidence: ["logs"] }] });
  assert.ok("errors" in withEvidence);
});
