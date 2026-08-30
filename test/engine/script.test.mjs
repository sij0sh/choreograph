import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { start, transition as engineTransition } from "../../src/engine/interpreter.ts";
import { validateAgainstWorkflow } from "../../src/persistence/validate-stored-execution.ts";
import { blocked, completed, cp, loop, memoryStore, needsWork, script, sequence, task, workflow } from "./helpers.mjs";

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === "outcome"
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


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
  const wf = workflow([script("emit", { spec: { stdout: "json" }, recovery: { maxAttempts: 2 } })]);
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
  const wf = workflow([script("emit", { spec: { stdout: "json" }, recovery: { maxAttempts: 1 } })]);
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
  const wf = workflow([script("slow", { recovery: { maxAttempts: 1 } })]);
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
  const wf = workflow([script("failing", { spec: { acceptedExitCodes: [0] }, recovery: { maxAttempts: 1 } })]);
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
  const restored = validateAgainstWorkflow(wf, result.state);
  assert.ok(restored.ok, restored.ok ? "" : restored.error);
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
  assert.match(next.error, /does not match the process leaf/);
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
test("the configured stderr mode is honored in the checkpoint data", () => {
  const exit = (stderr) => ({ type: "process-exit", key: "root/emit", exit: { code: 0, timedOut: false, stdout: "ok", stderr, truncated: false } });
  const runOnce = (options, event) => {
    const wf = workflow([script("emit", options)]);
    return transition(wf, start(wf, { runId: "r1" }).state, event);
  };
  const none = runOnce(undefined, exit("boom"));
  assert.ok(none.ok, none.ok ? "" : none.error);
  assert.deepEqual(none.state.checkpoints["root/emit"].data, { stdout: "ok" }, "the default none mode keeps stderr out of the data");
  const text = runOnce({ spec: { stderr: "text" } }, exit("boom"));
  assert.ok(text.ok, text.ok ? "" : text.error);
  assert.deepEqual(text.state.checkpoints["root/emit"].data, { stdout: "ok", stderr: "boom" }, "text mode adds the captured stderr");
  const json = runOnce({ spec: { stderr: "json" } }, exit('{"level":"warn"}'));
  assert.ok(json.ok, json.ok ? "" : json.error);
  assert.deepEqual(json.state.checkpoints["root/emit"].data, { stdout: "ok", stderr: { level: "warn" } }, "json mode parses stderr into the data");
});

test("stderr that is not valid json in json mode fails the step", () => {
  const wf = workflow([script("emit", { spec: { stderr: "json" }, recovery: { maxAttempts: 1 } })]);
  const started = start(wf, { runId: "r1" });
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/emit",
    exit: { code: 0, timedOut: false, stdout: "ok", stderr: "not json", truncated: false },
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.effect.kind, "stay");
  assert.match(next.state.checkpoints["root/emit"].summary, /stderr is not valid JSON/);
});


test("previewed text stdout with a store also sets the truncation flag", () => {
  const wf = workflow([script("chatter")]);
  const started = start(wf, { runId: "r1" });
  const store = recordingStore();
  const next = transition(wf, started.state, {
    type: "process-exit",
    key: "root/chatter",
    exit: { code: 0, timedOut: false, stdout: "y".repeat(20_000), stderr: "", truncated: false },
    store,
  });
  assert.ok(next.ok, next.ok ? "" : next.error);
  const data = next.state.checkpoints["root/chatter"].data;
  assert.equal(data.stdoutTruncated, true, "the preview is flagged in the data");
  assert.match(data.artifact.checksum, /^sha256-[0-9a-f]{64}$/);
  assert.equal(store.published[0].text, "y".repeat(20_000), "the full text is still preserved in the store");
});
