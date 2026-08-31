// Checkpoint commit cost and purity guard.
// History: audit 20260830181443-9c057767 (f-c2-withcheckpoint-copy) fixed
// quadratic commits by recording checkpoints in place, asserting 2C+k element
// ops. Audit 20260831023045-8711ec89 (corr-d1) proved that in-place recording
// leaks refused outcomes into live state (the phantom-checkpoint defect) and
// supersedes the constant-ops contract: commits are now copy-on-write, paying
// one record copy per commit (the same convention as upsertInvocation).
// This guard now asserts the corr-d1 contract: every commit (a) leaves the
// input execution untouched (purity, deep-equal), (b) produces fresh record
// and order objects (no aliasing with the caller's state), (c) costs element
// ops linear in the current checkpoint count (counted honestly by re-proxying
// each generation, so a regression to double-copying or hidden quadratic
// helpers fails), and (d) never duplicates or loses order entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { task, workflow } from './helpers.mjs';
import { start, transition as engineTransition } from '../../src/engine/interpreter.ts';

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === 'outcome'
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);

function countedView(state) {
  const counts = { recordOps: 0, orderOps: 0 };
  const record = new Proxy(state.checkpoints, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(target, prop)) counts.recordOps++;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (typeof prop === 'string') counts.recordOps++;
      return Reflect.set(target, prop, value);
    },
  });
  const order = new Proxy(state.checkpointOrder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) counts.orderOps++;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) counts.orderOps++;
      return Reflect.set(target, prop, value);
    },
  });
  return { state: { ...state, checkpoints: record, checkpointOrder: order }, counts };
}

function run(C) {
  const wf = workflow(Array.from({ length: C }, (_, i) => task(`t${String(i).padStart(4, '0')}`)));
  let state = start(wf, { runId: 'r1' }).state;
  let total = 0;
  for (let i = 0; i < C; i += 1) {
    const before = structuredClone(state);
    const view = countedView(state);
    const size = state.checkpointOrder.length;
    const result = transition(wf, view.state, { type: 'outcome', outcome: { status: 'completed', checkpoint: { summary: `s${i}` } } });
    assert.ok(result.ok, `C=${C} step ${i}: ${JSON.stringify(result.error)}`);
    // corr-d1 purity: the input execution is untouched by the commit.
    assert.deepEqual(state, before, `C=${C} step ${i}: the engine mutated its input execution`);
    // corr-d1 freshness: record and order are new objects, never aliased.
    assert.notEqual(result.state.checkpoints, state.checkpoints, `C=${C} step ${i}: record aliased`);
    assert.notEqual(result.state.checkpointOrder, state.checkpointOrder, `C=${C} step ${i}: order aliased`);
    // Cost: one record copy + one order copy per commit, linear in size.
    const ops = view.counts.recordOps + view.counts.orderOps;
    assert.ok(ops <= 2 * size + 8, `C=${C} step ${i}: ${ops} ops exceed 2*${size}+8 (multi-copy regression)`);
    total += ops;
    state = result.state;
  }
  // Order integrity: exactly one entry per committed position, no duplicates.
  assert.equal(state.checkpointOrder.length, C, `C=${C}: order holds ${state.checkpointOrder.length} entries`);
  assert.equal(Object.keys(state.checkpoints).length, C, `C=${C}: record holds ${Object.keys(state.checkpoints).length} checkpoints`);
  return total;
}

test('checkpoint commits are copy-on-write, pure, and linear per commit (corr-d1)', () => {
  const total = run(200);
  assert.ok(total > 0, 'the counting proxy observed the copy-on-write commits');
});

test('copy-on-write commits stay honest at scale (corr-d1)', { timeout: 60_000 }, () => {
  run(2000);
});
