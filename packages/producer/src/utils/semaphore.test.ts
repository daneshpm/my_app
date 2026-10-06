import { describe, expect, it } from "bun:test";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("makes release idempotent per acquisition", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const queued = sem.acquire();
    release();
    release(); // double release must not free a second slot
    const second = await queued;
    expect(sem.activeCount).toBe(1);
    const third = sem.acquire();
    expect(sem.waitingCount).toBe(1);
    second();
    (await third)();
    expect(sem.activeCount).toBe(0);
  });

  it("removes an aborted waiter from the queue without consuming a slot", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const controller = new AbortController();
    const waiting = sem.acquire(controller.signal);
    expect(sem.waitingCount).toBe(1);
    controller.abort(new Error("gone"));
    await expect(waiting).rejects.toThrow("gone");
    expect(sem.waitingCount).toBe(0);
    release();
    expect(sem.activeCount).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const sem = new Semaphore(2);
    const controller = new AbortController();
    controller.abort();
    await expect(sem.acquire(controller.signal)).rejects.toBeDefined();
    expect(sem.activeCount).toBe(0);
  });
});
