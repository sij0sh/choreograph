// c4 guard (audit 20260830181443-9c057767, f-c4-snapshot-order-scan).
// Operation-count through the real parseSnapshot. Metric: element reads of
// checkpointOrder, counted by a get-trap Proxy on the order array. Post-repair
// the parse visits the order a constant number of times (type some, dup Set,
// membership Set), so comparisons(C) <= 2C+M+k, the doubling ratio stays under
// 2.2 (quadratic is 4x), and C=5000 stays under 20k comparisons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot } from '../../src/persistence/snapshot.ts';

const key = (i) => `root/k${String(i).padStart(5, '0')}`;
const reversePerm = (n) => Array.from({ length: n }, (_, i) => key(n - 1 - i));

function comparisonsForParse(n, order) {
  let comparisons = 0;
  const counted = new Proxy(order, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) comparisons++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const parsed = parseSnapshot({
    v: 7,
    status: 'active',
    workflow: 'guard',
    delivered: true,
    execution: {
      workflowName: 'guard',
      runId: 'r',
      target: '',
      status: 'active',
      stack: [{ kind: 'task', blockId: 'b', key: 'leaf', attempt: 1 }],
      checkpoints: Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i), { summary: 's' }])),
      checkpointOrder: counted,
      plans: {},
      loops: {},
    },
  });
  return { comparisons, status: parsed.status };
}

function parseComparisons(n, order, expected) {
  const { comparisons, status } = comparisonsForParse(n, order);
  assert.equal(status, expected, `C=${n} M=${order.length}: expected ${expected}`);
  return comparisons;
}

const bound = (c, m, k = 32) => 2 * c + m + k;

test('checkpointOrder validation comparisons stay linear (c4 guard)', () => {
  const sizes = [800, 1600];
  const perm = sizes.map((n) => parseComparisons(n, reversePerm(n), 'active'));
  for (const [i, n] of sizes.entries()) {
    assert.ok(perm[i] <= bound(n, n), `C=${n}: ${perm[i]} comparisons exceed 2C+M+k = ${bound(n, n)}`);
  }
  const ratio = perm[1] / perm[0];
  assert.ok(ratio < 2.2, `doubling ratio ${ratio.toFixed(2)} reaches 2.2 (quadratic is 4x)`);

  const big = parseComparisons(5000, reversePerm(5000), 'active');
  assert.ok(big < 20_000, `C=5000: ${big} comparisons reach the 20000 budget`);

  // A short order is a rejection path (checkpoints missing from checkpointOrder):
  // the missing-key test must stay O(1) per key, so counts stay within the bound.
  const subset = parseComparisons(1600, reversePerm(1600).slice(0, 800), 'invalid');
  assert.ok(subset <= bound(1600, 800), `C=1600 M=800: ${subset} comparisons exceed 2C+M+k = ${bound(1600, 800)}`);
});
