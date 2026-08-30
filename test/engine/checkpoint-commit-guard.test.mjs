// c2 guard (audit 20260830181443-9c057767, f-c2-withcheckpoint-copy).
// Operation-count through a real start + C transitions. Metrics: element reads
// and writes on the checkpoints record and checkpointOrder, counted by Proxy
// traps (record own-property get/set, order numeric get/set; Object.hasOwn
// membership and the push length update are not element ops). Post-repair each
// commit costs two element ops (one record set + one order append), so
// cumulative ops(C) = 2C+k, the doubling ratio stays under 2.2 (the old
// spread+includes+copy commits were exactly 4x), and C=2000 stays under 20k ops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { task, workflow } from './helpers.mjs';
import { start, transition } from '../../src/engine/interpreter.ts';

function counted(started) {
  const counts = { recordOps: 0, orderOps: 0 };
  const record = new Proxy(started.state.checkpoints, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(target, prop)) counts.recordOps++;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (typeof prop === 'string') counts.recordOps++;
      return Reflect.set(target, prop, value);
    },
  });
  const order = new Proxy(started.state.checkpointOrder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) counts.orderOps++;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) counts.orderOps++;
      return Reflect.set(target, prop, value);
    },
  });
  return { state: { ...started.state, checkpoints: record, checkpointOrder: order }, counts };
}

function run(C) {
  const wf = workflow(Array.from({ length: C }, (_, i) => task(`t${String(i).padStart(4, '0')}`)));
  const countedRun = counted(start(wf, { runId: 'r1' }));
  let state = countedRun.state;
  for (let i = 0; i < C; i += 1) {
    const result = transition(wf, state, { type: 'outcome', outcome: { status: 'completed', checkpoint: { summary: `s${i}` } } });
    assert.ok(result.ok, `C=${C} step ${i}: ${JSON.stringify(result.error)}`);
    state = result.state;
  }
  return countedRun.counts.recordOps + countedRun.counts.orderOps;
}

const bound = (c, k = 32) => 2 * c + k;

test('checkpoint commits cost two element ops per commit (c2 guard)', () => {
  const sizes = [800, 1600];
  const totals = sizes.map(run);
  for (const [i, c] of sizes.entries()) {
    assert.ok(totals[i] <= bound(c), `C=${c}: ${totals[i]} ops exceed 2C+k = ${bound(c)}`);
  }
  const ratio = totals[1] / totals[0];
  assert.ok(ratio < 2.2, `doubling ratio ${ratio.toFixed(2)} reaches 2.2 (quadratic commits are 4x)`);

  const big = run(2000);
  assert.ok(big < 20_000, `C=2000: ${big} ops reach the 20000 budget`);
});
