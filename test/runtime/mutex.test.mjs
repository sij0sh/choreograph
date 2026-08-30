import test from "node:test";
import assert from "node:assert/strict";
import { AsyncMutex } from "../../src/runtime/mutex.ts";

test("acquire grants immediately when free and serializes later callers", async () => {
  const mutex = new AsyncMutex();
  const order = [];
  const releaseA = await mutex.acquire();
  order.push("a");
  const pending = mutex.acquire().then((release) => {
    order.push("b");
    release();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["a"], "the second caller waits");
  releaseA();
  await pending;
  assert.deepEqual(order, ["a", "b"]);
});

test("a queued caller whose signal fires rejects and frees its queue slot", async () => {
  const mutex = new AsyncMutex();
  const releaseA = await mutex.acquire();
  const controller = new AbortController();
  const waiting = mutex.acquire(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => waiting, /cancelled/);
  releaseA();
  // The mutex is reusable after the rejection.
  const release = await mutex.acquire();
  release();
});

test("an already-fired signal rejects without queueing", async () => {
  const mutex = new AsyncMutex();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => mutex.acquire(controller.signal), /cancelled/);
});

test("a fired signal does not disturb waiters queued behind it", async () => {
  const mutex = new AsyncMutex();
  const releaseA = await mutex.acquire();
  const controller = new AbortController();
  const rejecter = mutex.acquire(controller.signal).then(() => "granted", () => "rejected");
  const keeper = mutex.acquire().then((release) => {
    release();
    return "kept";
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseA();
  assert.deepEqual([await rejecter, await keeper], ["rejected", "kept"]);
});
