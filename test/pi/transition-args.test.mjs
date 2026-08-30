import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { registerWorkflowTools } from "../../src/pi/tools.ts";
import { BOUNDARY_CHECKPOINT_FIELDS, TRANSITION_FIELDS, TRANSITION_SHAPE } from "../../src/domain/checkpoint.ts";
import { workflow, task } from "../engine/helpers.mjs";

function transitionSchema() {
  const tools = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => [],
    setActiveTools: () => {},
    appendEntry: () => {},
    sendUserMessage: async () => {},
  };
  const runtime = new RuntimeCoordinator(pi, [], () => "# fallback", mkdtempSync(join(tmpdir(), "transition-schema-")));
  registerWorkflowTools(pi, runtime, [workflow([task("only")])], mkdtempSync(join(tmpdir(), "transition-schema-wf-")));
  return tools.get("workflow_transition").parameters;
}

const schema = transitionSchema();

const valid = {
  status: "completed",
  key: "root/only",
  met: ["done"],
  checkpoint: { summary: "the position is complete", data: { plan: { version: 1 } } },
};

test("a well-formed transition passes the schema", () => {
  assert.equal(Value.Check(schema, valid), true);
  assert.equal(Value.Check(schema, { status: "needs-work", key: "root/only", checkpoint: { summary: "broken" } }), true);
  assert.equal(Value.Check(schema, { status: "blocked", key: "root/only", checkpoint: { summary: "stuck" } }), true);
});

test("the tool schema derives transition and checkpoint enumerations", () => {
  assert.deepEqual(schema.properties.status.enum, [...TRANSITION_SHAPE.statuses]);
  assert.deepEqual(Object.keys(schema.properties), [...TRANSITION_FIELDS]);
  assert.deepEqual(Object.keys(schema.properties.checkpoint.properties), [...BOUNDARY_CHECKPOINT_FIELDS]);
  assert.deepEqual(
    schema.required,
    TRANSITION_FIELDS.filter((field) => TRANSITION_SHAPE.fields[field].required),
  );
  assert.deepEqual(
    schema.properties.checkpoint.required,
    BOUNDARY_CHECKPOINT_FIELDS.filter((field) => TRANSITION_SHAPE.checkpointFields[field].required),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.checkpoint.additionalProperties, false);
});

test("wrapper objects such as outcome or result are rejected", () => {
  assert.equal(Value.Check(schema, { outcome: valid }), false, "additionalProperties: false refuses the wrapper");
  assert.equal(Value.Check(schema, { result: valid }), false);
});

test("unknown top-level fields are rejected", () => {
  assert.equal(Value.Check(schema, { ...valid, outcomeStatus: "completed" }), false);
  assert.equal(Value.Check(schema, { ...valid, note: "extra" }), false);
});

test("nested outcome objects inside checkpoint are rejected", () => {
  assert.equal(Value.Check(schema, { status: "completed", checkpoint: { summary: "s", outcome: { met: ["done"] } } }), false);
});

test("met must be an array of criterion ids", () => {
  assert.equal(Value.Check(schema, { status: "completed", met: "done", checkpoint: { summary: "s" } }), false, "a string met is rejected");
  assert.equal(Value.Check(schema, { status: "completed", met: ["Bad_Id"], checkpoint: { summary: "s" } }), false, "ids must match ^[a-z][a-z0-9-]*$");
  assert.equal(Value.Check(schema, { status: "completed", met: ["done", "done"], checkpoint: { summary: "s" } }), false, "ids must be unique");
});

test("checkpoint.summary is required", () => {
  assert.equal(Value.Check(schema, { status: "completed", checkpoint: {} }), false);
  assert.equal(Value.Check(schema, { status: "completed", checkpoint: { data: { a: 1 } } }), false, "data does not stand in for summary");
});

test("unknown checkpoint fields are rejected", () => {
  assert.equal(Value.Check(schema, { status: "completed", checkpoint: { summary: "s", skipped: true } }), false);
});

test("status is required and restricted to the three outcomes", () => {
  assert.equal(Value.Check(schema, { checkpoint: { summary: "s" } }), false);
  assert.equal(Value.Check(schema, { status: "skipped", checkpoint: { summary: "s" } }), false);
});

test("issues entries require target and reason", () => {
  assert.equal(Value.Check(schema, { status: "needs-work", key: "root/only", checkpoint: { summary: "s" }, issues: [{ target: "root/frame" }] }), false);
  assert.equal(
    Value.Check(schema, { status: "needs-work", key: "root/only", checkpoint: { summary: "s" }, issues: [{ target: "root/frame", reason: "broken" }] }),
    true,
  );
});
