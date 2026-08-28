import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { start, transition } from "../../src/engine/interpreter.ts";
import { blocked, completed, cp, loop, memoryStore, needsWork, script, sequence, task, workflow } from "./helpers.mjs";

function recordingStore() {
  const published = [];
  const refOf = (name, content, mediaType) => ({
    invocationKey: "test-invocation",
    output: name,
    checksum: `sha256-${createHash("sha256").update(content).digest("hex")}`,
    size: Buffer.byteLength(content),
    mediaType,
  });
  return {
    published,
    publishJson(name, value) {
      const text = `${JSON.stringify(value)}\n`;
      const ref = refOf(name, text, "application/json");
      published.push({ name, ref, text, value });
      return ref;
    },
    publishText(name, text, mediaType = "text/plain; charset=utf-8") {
      const ref = refOf(name, text, mediaType);
      published.push({ name, ref, text });
      return ref;
    },
  };
}

const BIG_JSON = JSON.stringify({ rows: Array.from({ length: 600 }, (_, index) => ({ id: index, note: "x".repeat(48) })) });

function exitEvent(key, code) {
  return {
    type: "process-exit",
    key,
    exit: { code, timedOut: false, stdout: `${JSON.stringify({ exitCode: code })}\n`, stderr: "", truncated: false },
  };
}

function run(children) {
  return start(workflow(children), { runId: "r1", target: "t" });
}

test("start at a script step returns a run-process effect", () => {
  const result = run([script("run-tests"), task("deliver")]);
  assert.ok(result.ok);
  assert.equal(result.effect.kind, "run-process");
  assert.equal(result.effect.key, "root/run-tests");
  assert.deepEqual(result.effect.node.spec.argv[0], "node");
  assert.equal(result.effect.node.runner, "process", "the effect names its runner");
  assert.equal(result.state.stack.at(-1).blockId, "run-tests");
  assert.equal(result.state.stack.at(-1).kind, "task", "script leaves reuse the task frame kind");
});

test("accepted exit completes the script and advances without a model turn", () => {
  const wf = workflow([script("run-tests"), task("deliver")]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/run-tests",
    exit: { code: 0, timedOut: false, stdout: "ok", stderr: "", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "deliver");
  assert.equal(next.state.stack.at(-1).blockId, "deliver");
  assert.equal(next.state.checkpoints["root/run-tests"].data.stdout, "ok");
});

test("json stdout parses into the checkpoint data", () => {
  const wf = workflow([script("emit", { spec: { stdout: "json" } })]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: '{"pass":7,"fail":0}\n', stderr: "", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "complete");
  assert.deepEqual(next.state.checkpoints["root/emit"].data, { pass: 7, fail: 0 });
});

test("invalid json stdout applies the repair policy", () => {
  const wf = workflow([script("emit", { spec: { stdout: "json" }, recovery: { max_attempts: 2, strategy: ["retry", "block"] } })]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: "not json", stderr: "", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "deliver", "retry keeps the run at the script");
  assert.equal(next.state.stack.at(-1).blockId, "emit");
  assert.equal(next.state.stack.at(-1).attempt, 2, "the retry bumps the attempt");
});

test("exhausted retries park the run at the script with a stay effect", () => {
  const wf = workflow([script("emit", { spec: { stdout: "json" }, recovery: { maxAttempts: 1, strategy: ["retry", "block"] } })]);
  const started = start(wf, { runId: "r1" });
  const last = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: "nope", stderr: "", truncated: false },
  });
  assert.ok(last.ok, last.ok ? "" : last.error);
  assert.equal(last.effect.kind, "stay");
  assert.equal(last.state.stack.at(-1).blockId, "emit");
  assert.match(last.state.checkpoints["root/emit"].summary, /not valid JSON/);
});

test("timeout exit applies repair and names the timeout", () => {
  const wf = workflow([script("slow", { recovery: { max_attempts: 1, strategy: ["block"] } })]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/slow",
    exit: { code: undefined, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "stay");
  assert.match(next.state.checkpoints["root/slow"].summary, /timed out/);
});

test("rejected exit code applies repair and names the code", () => {
  const wf = workflow([script("failing", { spec: { acceptedExitCodes: [0] }, recovery: { max_attempts: 1, strategy: ["block"] } })]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/failing",
    exit: { code: 3, timedOut: false, stdout: "", stderr: "boom", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "stay");
  assert.match(next.state.checkpoints["root/failing"].summary, /code 3/);
});

test("accepted non-zero exit codes complete the script", () => {
  const wf = workflow([script("probe", { spec: { acceptedExitCodes: [0, 2] } })]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/probe",
    exit: { code: 2, timedOut: false, stdout: "partial", stderr: "", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "complete");
});

test("output contract violation applies repair", () => {
  const contracts = { report: { type: "object", required: ["pass"], additionalProperties: false, properties: { pass: { type: "integer" } } } };
  const wf = workflow([script("emit", { spec: { stdout: "json" }, output: "report" })], { contracts });
  let result = start(wf, { runId: "r1" });
  assert.ok(result.ok);
  const failing = { code: 0, timedOut: false, stdout: '{"fail":1}', stderr: "", truncated: false };
  result = transition(wf, result.state, { type: "process-exit", key: "root/emit", exit: failing });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.effect.kind, "deliver", "default recovery retries first");
  result = transition(wf, result.state, { type: "process-exit", key: "root/emit", exit: failing });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.effect.kind, "stay", "with retries exhausted it blocks");
  assert.match(result.state.checkpoints["root/emit"].summary, /violates|invalid|missing/i);
});

test("output contract satisfaction completes with the contract data", () => {
  const contracts = { report: { type: "object", required: ["pass"], additionalProperties: false, properties: { pass: { type: "integer" } } } };
  const wf = workflow([script("emit", { spec: { stdout: "json" }, output: "report" })], { contracts });
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: '{"pass":3}', stderr: "", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "complete");
});

test("workflow_transition outcomes are rejected at script positions", () => {
  const wf = workflow([script("run-tests"), task("deliver")]);
  const started = start(wf, { runId: "r1" });
  const attempt = transition(wf, started.state, { type: "outcome", outcome: completed(cp("done")) });
  assert.ok(!attempt.ok);
  assert.match(attempt.error, /does not accept transitions/);
  const blockedAttempt = transition(wf, started.state, { type: "outcome", outcome: blocked(cp("stuck")) });
  assert.ok(!blockedAttempt.ok);
  const needsWorkAttempt = transition(wf, started.state, { type: "outcome", outcome: needsWork(cp("issues")) });
  assert.ok(!needsWorkAttempt.ok);
});

test("process exit for a foreign key is rejected", () => {
  const wf = workflow([script("run-tests")]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/other",
    exit: { code: 0, timedOut: false, stdout: "", stderr: "", truncated: false },
  });
  assert.ok(!next.ok);
  assert.match(next.error, /does not match the script leaf/);
});

test("guarded script steps are skipped like tasks", () => {
  const wf = workflow([
    task("seed", { done: ["s"] }),
    script("gate", { guard: { from: "seed", select: "/data/ready", op: "equals", value: false } }),
    task("deliver"),
  ]);
  const started = start(wf, { runId: "r1" });
  const seeded = transition(wf, started.state, { type: "outcome", outcome: completed(cp("seeded", { ready: true }), ["s"]) });
  assert.ok(seeded.ok, seeded.ok ? "" : seeded.error);
  assert.equal(seeded.effect.kind, "deliver");
  assert.equal(seeded.state.stack.at(-1).blockId, "deliver", "the guarded script is skipped, not executed");
  assert.equal(seeded.state.checkpoints["root/gate"].skipped, true);
});

test("two scripts in sequence chain through run-process effects", () => {
  const wf = workflow([script("first"), script("second")]);
  let result = start(wf, { runId: "r1" });
  assert.equal(result.effect.kind, "run-process");
  assert.equal(result.effect.key, "root/first");
  result = transition(wf, result.state, {
    type: "process-exit",
    key: "root/first",
    exit: { code: 0, timedOut: false, stdout: "a", stderr: "", truncated: false },
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.effect.kind, "run-process");
  assert.equal(result.effect.key, "root/second");
  result = transition(wf, result.state, {
    type: "process-exit",
    key: "root/second",
    exit: { code: 0, timedOut: false, stdout: "b", stderr: "", truncated: false },
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.effect.kind, "complete");
});

test("oversized json stdout publishes to the artifact store instead of failing", () => {
  const wf = workflow([script("emit", { spec: { stdout: "json" } })]);
  const started = start(wf, { runId: "r1" });
  const store = recordingStore();
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: BIG_JSON, stderr: "", truncated: false },
    store,
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "complete");
  const ref = next.state.checkpoints["root/emit"].data;
  assert.equal(ref.output, "output");
  assert.equal(ref.mediaType, "application/json");
  assert.match(ref.checksum, /^sha256-[0-9a-f]{64}$/);
  assert.ok(ref.size >= BIG_JSON.length, "the ref records the full stored size");
  assert.equal(store.published.length, 1);
  assert.deepEqual(store.published[0].value, JSON.parse(BIG_JSON));
  assert.match(next.state.checkpoints["root/emit"].summary, /artifact store/);
});

test("oversized text stdout keeps a preview inline and the full text in the store", () => {
  const wf = workflow([script("chatter")]);
  const started = start(wf, { runId: "r1" });
  const store = recordingStore();
  const full = "y".repeat(20_000);
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/chatter",
    exit: { code: 0, timedOut: false, stdout: full, stderr: "", truncated: false },
    store,
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "complete");
  const data = next.state.checkpoints["root/chatter"].data;
  assert.ok(data.stdout.length < 256, "the inline stdout is a bounded preview");
  assert.match(data.stdout, /\.\.\.$/);
  assert.match(data.artifact.checksum, /^sha256-[0-9a-f]{64}$/);
  assert.equal(store.published[0].text, full, "the full text is preserved in the store");
});

test("without a store an oversized json stdout still fails the script", () => {
  const wf = workflow([script("emit", { spec: { stdout: "json" } })]);
  let state = start(wf, { runId: "r1" }).state;
  const exit = { code: 0, timedOut: false, stdout: BIG_JSON, stderr: "", truncated: false };
  const retried = transition(wf, state, { type: "process-exit", key: "root/emit", exit });
  assert.ok(retried.ok, retried.ok ? "" : retried.error);
  assert.equal(retried.effect.kind, "deliver", "default recovery retries first");
  state = retried.state;
  const parked = transition(wf, state, { type: "process-exit", key: "root/emit", exit });
  assert.ok(parked.ok, parked.ok ? "" : parked.error);
  assert.equal(parked.effect.kind, "stay", "with retries exhausted it blocks");
  assert.match(parked.state.checkpoints["root/emit"].summary, /exceeds/);
});

test("a failing output contract rejects the script even when a store is available", () => {
  const contracts = { report: { type: "object", required: ["pass"], additionalProperties: false, properties: { pass: { type: "integer" } } } };
  const wf = workflow([script("emit", { spec: { stdout: "json" }, output: "report" })], { contracts });
  const started = start(wf, { runId: "r1" });
  const store = recordingStore();
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: BIG_JSON, stderr: "", truncated: false },
    store,
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "deliver", "the contract failure retries instead of publishing");
  assert.equal(store.published.length, 0, "nothing is published for a contract violation");
});


test("a loop with a script body records its aggregate through the process-exit seam", () => {
  const base = script("x").script;
  const body = script("apply-fix", { spec: { ...base, stdout: "json", acceptedExitCodes: [0, 1] } });
  const fix = loop("until-green", "repeat-until", { maxIterations: 3, body, condition: { from: "apply-fix", select: "/data/exitCode", op: "equals", value: 0 } });
  const wf = workflow([fix, task("deliver")]);
  const store = memoryStore();
  let state = start(wf, { runId: "r1" }, store).state;
  let result = transition(wf, state, exitEvent("root/until-green/loop[1]/apply-fix", 1), store);
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.state.stack.at(-1).key, "root/until-green/loop[2]/apply-fix", "a false condition reruns the body");
  result = transition(wf, result.state, exitEvent("root/until-green/loop[2]/apply-fix", 0), store);
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.effect.kind, "deliver");
  assert.equal(result.state.stack.at(-1).blockId, "deliver");
  const aggregate = result.state.checkpoints["root/until-green"];
  assert.equal(aggregate.data.mode, "repeat-until");
  assert.equal(aggregate.data.iterations, 2);
  const ref = aggregate.data.results[0].outputs["apply-fix"];
  assert.equal(ref.output, "1/apply-fix");
  assert.deepEqual(store.published.at(-1).value, { exitCode: 0 });
});
