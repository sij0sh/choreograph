// c3 guard (audit 20260830181443-9c057767, f-c3-plan-flatmap-per-checkpoint).
// Structural + operation-count through the real validateAgainstWorkflow.
// Metrics counted by traps on state.plans and state.checkpoints: plan-record
// enumerations, plan-node element reads, checkpoint record gets. Post-repair
// the checkpoint loop reads a hoisted index: plan-node enumeration == 1 per
// validate call, node reads are invariant in C, and visits(C) = P*N + k*C
// keeps the doubling ratio under 2.1 (pre-repair node reads scale with C*P*N).
import test from 'node:test';
import assert from 'node:assert/strict';
import { task, workflow } from '../engine/helpers.mjs';
import { start, transition as engineTransition } from '../../src/engine/interpreter.ts';
import { validateAgainstWorkflow } from '../../src/persistence/validate-stored-run.ts';

// Keyed outcomes (corr-c1): the engine requires each outcome event to carry the
// leaf key. Tests inject it automatically; an explicit key in the event wins.
const transition = (wf, state, event, store) =>
  event?.type === 'outcome'
    ? engineTransition(wf, state, { ...event, outcome: { key: state?.stack?.at(-1)?.key, ...event.outcome } }, store)
    : engineTransition(wf, state, event, store);


const OPERATORS = new Map([
  ['inspect', { id: 'inspect', path: 'operators/inspect.md', description: 'Inspect code.' }],
  ['trace', { id: 'trace', path: 'operators/trace.md', description: 'Trace flow.' }],
]);

const node = (id, operator) => ({ id, operator, objective: `Objective for ${id}`, done: [`${id}-done`] });

function planState() {
  const wf = workflow([task('discover'), { kind: 'plan', id: 'investigate', operators: ['inspect', 'trace'] }], { operators: OPERATORS });
  let state = start(wf, { runId: 'r1' }).state;
  state = transition(wf, state, { type: 'outcome', outcome: { status: 'completed', checkpoint: { summary: 'framed' } } }).state;
  state = transition(wf, state, {
    type: 'outcome',
    outcome: { status: 'completed', checkpoint: { summary: 'P', data: { plan: { version: 1, nodes: [node('probe', 'inspect'), node('map', 'trace')] } } } },
  }).state;
  return { wf, state };
}

function countedState(state) {
  const counts = { planEnumerations: 0, nodeReads: 0, checkpointGets: 0 };
  const countNodes = (nodes) => new Proxy(nodes, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) counts.nodeReads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const countPlan = (plan) => new Proxy(plan, {
    get(target, prop, receiver) {
      if (prop !== 'plan') return Reflect.get(target, prop, receiver);
      const inner = Reflect.get(target, prop, receiver);
      return new Proxy(inner, {
        get(t2, p2, r2) {
          if (p2 !== 'nodes') return Reflect.get(t2, p2, r2);
          return countNodes(Reflect.get(t2, p2, r2));
        },
      });
    },
  });
  const plans = new Proxy(state.plans, {
    ownKeys() {
      counts.planEnumerations++;
      return Reflect.ownKeys(state.plans);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      return value && typeof value === 'object' ? countPlan(value) : value;
    },
  });
  const checkpoints = new Proxy(state.checkpoints, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(target, prop)) counts.checkpointGets++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { plans, checkpoints, counts };
}

function validateWith(bulk) {
  const { wf, state } = planState();
  const checkpoints = { ...state.checkpoints };
  checkpoints['root/investigate/probe'] = { summary: 'probe' };
  checkpoints['root/investigate/map'] = { summary: 'map' };
  for (let i = 0; i < bulk; i += 1) checkpoints[`bulk-${String(i).padStart(5, '0')}/discover`] = { summary: 's' };
  const counted = countedState({ ...state, checkpoints });
  const execution = { ...state, checkpoints: counted.checkpoints, plans: counted.plans };
  const result = validateAgainstWorkflow(wf, execution);
  assert.ok(result.ok, `bulk=${bulk}: expected valid, got ${JSON.stringify(result.error)}`);
  return { ...counted.counts, total: Object.keys(checkpoints).length };
}

test('checkpoint validation plan-node lookups are indexed once (c3 guard)', () => {
  const sizes = [800, 1600];
  const runs = sizes.map(validateWith);
  const visits = runs.map((c, i) => c.nodeReads + c.checkpointGets);

  for (const [i, bulk] of sizes.entries()) {
    const c = runs[i];
    // Exactly one plan-record enumeration serves every checkpoint lookup
    // (the hoisted index); the other is the plan-validation loop.
    assert.equal(c.planEnumerations, 2, `bulk=${bulk}: ${c.planEnumerations} plan enumerations, expected index(1) + plan validation(1)`);
    assert.equal(c.checkpointGets, c.total, `bulk=${bulk}: ${c.checkpointGets} checkpoint gets, expected one per key (${c.total})`);
  }
  // Plan-node reads are invariant in C: the index enumerates each plan's nodes
  // once no matter how many checkpoints look up into it.
  assert.equal(runs[1].nodeReads, runs[0].nodeReads, `node reads grew with C: ${runs[0].nodeReads} -> ${runs[1].nodeReads}`);
  assert.ok(runs[0].nodeReads <= 64 * 1 * 2, `node reads ${runs[0].nodeReads} exceed the 64*P*N cap`);

  const ratio = visits[1] / visits[0];
  assert.ok(ratio < 2.1, `visits doubling ratio ${ratio.toFixed(2)} reaches 2.1 (linear is 2x)`);
});
