import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.ts";
import { registerWorkflowTools } from "../../src/pi/tools.ts";
import { DEFAULT_TARGET } from "../../src/runtime/coordinator.ts";
import { LIMITS } from "../../src/domain/limits.ts";
import { workflow, task } from "../engine/helpers.mjs";
import { registerWorkflowCommands } from "../../src/pi/commands.ts";

// The start tool enforces the 4096-byte target boundary before startWorkflow so an
// oversized target cannot reach the engine after the retention sweep side effect and
// surface as a raw rethrow. UTF-16 length (schema maxLength) and UTF-8 bytes disagree
// for multi-byte text; the byte check is the authority.

function makeTools() {
  const tools = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => [],
    setActiveTools: () => {},
    appendEntry: () => {},
    sendUserMessage: async () => {},
  };
  const runtime = new RuntimeCoordinator(pi, [], () => "# fallback", mkdtempSync(join(tmpdir(), "start-boundary-")));
  registerWorkflowTools(pi, runtime, [workflow([task("only", { done: ["done"] })], { piVisibility: true })]);
  return { tools, runtime };
}

const ctx = { ui: { notify() {}, setStatus() {} } };

test("a target of exactly the byte limit starts", async () => {
  const { tools, runtime } = makeTools();
  const start = tools.get("workflow_start");
  const result = await start.execute("id", { name: "demo", target: "x".repeat(LIMITS.targetBytes) }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "active");
  assert.equal(runtime.state.status, "active");
});

test("one byte over the limit is a styled error and never starts", async () => {
  const { tools, runtime } = makeTools();
  const start = tools.get("workflow_start");
  const result = await start.execute("id", { name: "demo", target: "x".repeat(LIMITS.targetBytes + 1) }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "target-too-long");
  assert.match(result.content[0].text, new RegExp(`target exceeds ${LIMITS.targetBytes} bytes`));
  assert.equal(runtime.state.status, "idle", "startWorkflow was never reached, so nothing was created");
});

test("multi-byte text within UTF-16 limits is rejected by bytes", async () => {
  const { tools, runtime } = makeTools();
  const start = tools.get("workflow_start");
  const cjk = "件".repeat(11000); // 11000 UTF-16 units, 33000 UTF-8 bytes
  assert.ok(cjk.length <= LIMITS.targetBytes, "the schema maxLength cannot catch this; the byte check must");
  const result = await start.execute("id", { name: "demo", target: cjk }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "target-too-long");
  assert.equal(runtime.state.status, "idle");
});

test("a blank target falls through to the default target", async () => {
  const { tools, runtime } = makeTools();
  const start = tools.get("workflow_start");
  const result = await start.execute("id", { name: "demo", target: "   " }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "active");
  assert.equal(runtime.state.execution.target, DEFAULT_TARGET);
});

test("the schema pre-filter and enforcement agree on units", () => {
  const { tools } = makeTools();
  const schema = tools.get("workflow_start").parameters;
  assert.equal(schema.properties.target.maxLength, LIMITS.targetBytes);
  assert.match(schema.properties.target.description, new RegExp(`at most ${LIMITS.targetBytes} bytes`));
  assert.equal(Value.Check(schema, { name: "demo", target: "x".repeat(LIMITS.targetBytes) }), true);
  assert.equal(Value.Check(schema, { name: "demo", target: "x".repeat(LIMITS.targetBytes + 1) }), false);
});

test("the command path rejects oversized targets with a notice", async () => {
  const commands = new Map();
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    appendEntry: () => {},
    sendUserMessage: async () => {},
  };
  const runtime = new RuntimeCoordinator(pi, [], () => "# fallback", mkdtempSync(join(tmpdir(), "start-boundary-cmd-")));
  const notices = [];
  const ctx = { ui: { notify: (text, level) => notices.push({ text, level }), setStatus() {} } };
  registerWorkflowCommands(pi, runtime, [workflow([task("only", { done: ["done"] })], { piVisibility: true })]);
  await commands.get("demo").handler("x".repeat(LIMITS.targetBytes + 1), ctx);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].text, new RegExp(`target exceeds ${LIMITS.targetBytes} bytes`));
  assert.equal(runtime.state.status, "idle");
});
