// c7 guard (audit 20260830181443-9c057767, f-c7-binding-order-scan).
// Operation-count + structure on the real binding and prompt paths. The index
// is built once per checkpoints record (a per-run cost, not a per-position
// lookup), so each window warms it and resets the counters: the measured
// steady state is two binding lookups (one deep task binding, one unexecuted
// plan block) plus the real position envelope render. Post-repair the binding
// path performs zero checkpointOrder element reads (keyed maps), per-position
// visits stay within k*(1+B+G) independent of C, and doubling C at fixed
// shape stays under 1.5x.
import test from 'node:test';
import assert from 'node:assert/strict';
import { task, workflow } from '../engine/helpers.mjs';
import { start, transition } from '../../src/engine/interpreter.ts';
import { resolveBinding } from '../../src/domain/artifacts.ts';
import { renderPositionEnvelope } from '../../src/runtime/prompts.ts';

const OPERATORS = new Map([['inspect', { id: 'inspect', path: 'operators/inspect.md', description: 'Inspect code.' }]]);

const build = (C) => {
  const children = Array.from({ length: C }, (_, i) => task(i === 0 ? 'first' : `t${String(i).padStart(4, '0')}`));
  children.push({ kind: 'plan', id: 'probe-plan', operators: ['inspect'] });
  return workflow(children, { operators: OPERATORS });
};

function lastTaskState(wf, C) {
  let state = start(wf, { runId: 'r1' }).state;
  for (let i = 0; i < C - 1; i += 1) {
    state = transition(wf, state, { type: 'outcome', outcome: { status: 'completed', checkpoint: { summary: `s${i}` } } }).state;
  }
  return state;
}

function countedState(state) {
  const counts = { orderGets: 0, recordGets: 0 };
  const record = new Proxy(state.checkpoints, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(target, prop)) counts.recordGets++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const order = new Proxy(state.checkpointOrder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) counts.orderGets++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { state: { ...state, checkpoints: record, checkpointOrder: order }, counts };
}

function steadyStateVisits(C) {
  const wf = build(C);
  const raw = lastTaskState(wf, C);
  const window = countedState(raw);

  // Warm the per-record index through the counted identity, then measure the
  // steady state only (the one-time build is a per-run cost, not a lookup).
  resolveBinding(wf, window.state, { from: 'first', select: '/summary' });
  window.counts.orderGets = 0;
  window.counts.recordGets = 0;

  const deep = resolveBinding(wf, window.state, { from: 'first', select: '/summary' });
  assert.ok(deep.ok, `deep binding failed: ${JSON.stringify(deep.error)}`);
  assert.equal(deep.value, 's0', 'the deep binding resolves the first task checkpoint');
  const planMiss = resolveBinding(wf, window.state, { from: 'probe-plan', select: '/summary' });
  assert.ok(!planMiss.ok, 'an unexecuted plan block produces no artifact');
  const bindingOrderGets = window.counts.orderGets;
  assert.equal(bindingOrderGets, 0, `the binding path scanned checkpointOrder ${bindingOrderGets} times`);

  renderPositionEnvelope(wf, window.state, () => '# body');
  return bindingOrderGets + window.counts.recordGets + window.counts.orderGets;
}

test('binding and prompt lookups stay independent of C (c7 guard)', () => {
  const sizes = [800, 1600];
  const visits = sizes.map(steadyStateVisits);
  const perPosition = visits[0];
  // Fixed shape: one deep binding + one plan lookup + one envelope render.
  const bound = 32 * (1 + 1 + 1);
  assert.ok(perPosition <= bound, `per-position visits ${perPosition} exceed k*(1+B+G) = ${bound}`);
  const ratio = visits[1] / visits[0];
  assert.ok(ratio < 1.5, `doubling C ratio ${ratio.toFixed(2)} reaches 1.5 at fixed shape`);
});
