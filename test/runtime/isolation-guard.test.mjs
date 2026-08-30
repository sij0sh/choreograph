// c6 guard (audit 20260830181443-9c057767, f-c6-isolation-context-scan).
// Operation-count through the real memoized isolator over the real event-stream
// shape (pi fires context before each LLM call; each turn appends ~2 messages).
// Metrics: message visits via a get-trap Proxy on `role` (isolation.ts reads
// role exactly once per visited message); joined bytes via an
// Array.prototype.join shim. Post-repair doubling the position turn count keeps
// cumulative visit growth < 2.2x (quadratic is 4x) and no event joins message
// text (joined bytes < 4 KiB per event).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextIsolator } from '../../src/runtime/isolation.ts';
import { controlPrefix } from '../../src/runtime/prompts.ts';

const RUN = 'r-guard';

let visits = 0;
let joinChars = 0;

function counted(message) {
  return new Proxy(message, {
    get(target, prop) {
      if (prop === 'role') visits++;
      return target[prop];
    },
  });
}

function measured(fn) {
  const realJoin = Array.prototype.join;
  Array.prototype.join = function (sep) {
    const joined = realJoin.call(this, sep);
    joinChars += joined.length;
    return joined;
  };
  try {
    visits = 0;
    joinChars = 0;
    const result = fn();
    return { visits, joinChars, result };
  } finally {
    Array.prototype.join = realJoin;
  }
}

const control = () => counted({ role: 'user', content: [{ type: 'text', text: `${controlPrefix(RUN)} at frame.` }] });
const foreign = () => counted({ role: 'user', content: [{ type: 'text', text: 'Continue workflow `other` at frame.' }] });
const turn = (i) => [
  counted({ role: 'assistant', content: [{ type: 'text', text: `assistant turn ${i}` }] }),
  counted({ role: 'toolResult', content: [{ type: 'text', text: `ok ${i}` }] }),
];

// T context events inside one position; each LLM call appends one turn.
function cumulative(T, first) {
  const isolate = createContextIsolator();
  const messages = [first()];
  let cumVisits = 0;
  let maxJoined = 0;
  for (let i = 0; i < T; i += 1) {
    messages.push(...turn(i));
    const sample = measured(() => isolate(messages, RUN));
    cumVisits += sample.visits;
    maxJoined = Math.max(maxJoined, sample.joinChars);
  }
  return { cumVisits, maxJoined };
}

test('cumulative visits stay linear in position turns (c6 guard)', () => {
  const sizes = [400, 800];
  const runs = sizes.map((t) => cumulative(t, control));
  for (const [i, t] of sizes.entries()) {
    assert.ok(runs[i].cumVisits <= 4 * t + 4, `T=${t}: ${runs[i].cumVisits} visits exceed the linear 4T+4 budget`);
  }
  const ratio = runs[1].cumVisits / runs[0].cumVisits;
  assert.ok(ratio < 2.2, `doubling ratio ${ratio.toFixed(2)} reaches 2.2 (quadratic is 4x)`);
});

test('joined bytes stay under 4 KiB per event (c6 guard)', () => {
  const { maxJoined } = cumulative(50, control);
  assert.ok(maxJoined < 4096, `an event joined ${maxJoined} bytes (budget 4096)`);
});

test('the pre-delivery miss window stays linear too (c6 guard)', () => {
  const sizes = [400, 800];
  const runs = sizes.map((t) => cumulative(t, foreign));
  const ratio = runs[1].cumVisits / runs[0].cumVisits;
  assert.ok(ratio < 2.2, `miss-window doubling ratio ${ratio.toFixed(2)} reaches 2.2 (quadratic is 4x)`);
});
