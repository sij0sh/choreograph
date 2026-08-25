import test from "node:test";
import assert from "node:assert/strict";
import { validateDynamicPlan } from "../../src/planning/validate.ts";
import { firstIncompleteNode, invalidateResults } from "../../src/planning/graph.ts";

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
    retainedResultIds: new Set(options.retained ?? []),
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

test("dependencies must be earlier or retained", () => {
  const forward = validate({ version: 1, nodes: [node("a", "inspect", { dependsOn: ["b"] }), node("b")] });
  assert.ok("errors" in forward);
  const retained = validate({ version: 1, nodes: [node("a", "inspect", { dependsOn: ["kept"] }), node("b")] }, { retained: ["kept"] });
  assert.ok("plan" in retained);
  const self = validate({ version: 1, nodes: [node("a", "inspect", { dependsOn: ["a"] }), node("b")] });
  assert.ok("errors" in self);
});

test("node ids must not collide with retained results", () => {
  const result = validate({ version: 1, nodes: [node("kept"), node("b")] }, { retained: ["kept"] });
  assert.ok("errors" in result);
  assert.ok(result.errors.some((error) => /retained result/.test(error)));
});

test("firstIncompleteNode finds the first node without a result", () => {
  const execution = {
    blockId: "investigate",
    revision: 1,
    replans: 0,
    plan: { version: 1, nodes: [node("a"), node("b"), node("c")] },
    results: { a: { id: "a", summary: "done" }, c: { id: "c", summary: "done" } },
  };
  assert.equal(firstIncompleteNode(execution).id, "b");
  const finished = { ...execution, results: { a: { id: "a", summary: "" }, b: { id: "b", summary: "" }, c: { id: "c", summary: "" } } };
  assert.equal(firstIncompleteNode(finished), undefined);
});

test("invalidateResults removes transitive dependents in declaration order", () => {
  const execution = {
    blockId: "investigate",
    revision: 1,
    replans: 0,
    plan: {
      version: 1,
      nodes: [node("a"), node("b", "trace", { dependsOn: ["a"] }), node("c", "trace", { dependsOn: ["b"] }), node("d")],
    },
    results: { a: { id: "a", summary: "1" }, b: { id: "b", summary: "2" }, c: { id: "c", summary: "3" }, d: { id: "d", summary: "4" } },
  };
  const { execution: next, removed } = invalidateResults(execution, ["a"]);
  assert.deepEqual(removed, ["a", "b", "c"], "dependents invalidate transitively");
  assert.deepEqual(Object.keys(next.results), ["d"], "independent results survive");
  assert.deepEqual(invalidateResults(execution, ["ghost"]).removed, []);
});