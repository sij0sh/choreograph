/**
 * A FIFO async mutex (corr-c8): serializes the abort terminal commit against
 * the transition epilogue so the losing side cannot sample a stale run status.
 * A caller waiting on the lock can pass an AbortSignal; a fired signal removes
 * it from the queue and rejects instead of wedging the operation.
 */
export class AsyncMutex {
  private locked = false;
  private readonly queue: (() => void)[] = [];

  /** Resolves with the release function once the lock is held; rejects if the signal fires first. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("workflow operation cancelled");
    if (!this.locked) {
      this.locked = true;
      return this.release;
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter = (): void => {
        cleanup();
        resolve(this.release);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error("workflow operation cancelled"));
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Hands the lock to the next waiter, or frees it when the queue is empty. */
  private release = (): void => {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  };
}
