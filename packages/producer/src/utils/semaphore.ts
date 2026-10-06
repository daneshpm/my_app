/**
 * Simple async semaphore for limiting concurrent operations.
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrent: number) {}

  /**
   * Acquire a slot. The returned release function is idempotent: calling it
   * more than once frees the slot only once. When `signal` aborts while the
   * caller is still queued, the waiter is removed from the queue and the
   * promise rejects with the abort reason (no slot is consumed).
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal);

    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortReason(signal));
      };
      const waiter = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve(this.createRelease());
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Current number of active slots. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of waiters in the queue. */
  get waitingCount(): number {
    return this.queue.length;
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("Semaphore acquire aborted");
}
