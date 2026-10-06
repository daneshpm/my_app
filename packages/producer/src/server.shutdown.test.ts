import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";

// Graceful shutdown lives inside startServer(), so drive it through its seams: a fake
// HTTP listener (captures the Hono fetch), a recorded SIGTERM handler, and stubbed
// engine cleanup / process.exit.
const calls = { killTrackedProcesses: 0, drainBrowserPool: 0, serverClosed: 0, closeIdle: 0 };
const render: { signal?: AbortSignal; started?: () => void } = {};

const realOrchestrator = await import("./services/renderOrchestrator.js");
mock.module("./services/renderOrchestrator.js", () => ({
  ...realOrchestrator,
  // Blocks until aborted, like a long render, then rejects the way the real one does.
  executeRenderJob: (
    _job: unknown,
    _dir: string,
    _out: string,
    _cb: unknown,
    signal: AbortSignal,
  ) =>
    new Promise<void>((_resolve, reject) => {
      render.signal = signal;
      render.started?.();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
}));

const realEngine = await import("@hyperframes/engine");
mock.module("@hyperframes/engine", () => ({
  ...realEngine,
  killTrackedProcesses: () => {
    calls.killTrackedProcesses++;
  },
  drainBrowserPool: async () => {
    calls.drainBrowserPool++;
  },
}));

let fetchHandler: ((req: Request) => Response | Promise<Response>) | undefined;
mock.module("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    fetchHandler = opts.fetch;
    return {
      setTimeout: () => {},
      keepAliveTimeout: 0,
      headersTimeout: 0,
      requestTimeout: 0,
      closeIdleConnections: () => {
        calls.closeIdle++;
      },
      close: (cb?: () => void) => {
        calls.serverClosed++;
        cb?.();
      },
    };
  },
}));

const { startServer } = await import("./server");

describe("graceful shutdown", () => {
  const handlers = new Map<string, () => unknown>();
  const exits: Array<number | undefined> = [];
  let onSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  const prevHealth = process.env.PRODUCER_DISABLE_HEALTH_WORKER;

  beforeAll(() => {
    process.env.PRODUCER_DISABLE_HEALTH_WORKER = "1";
    delete process.env.PRODUCER_AUTH_TOKEN;
    onSpy = spyOn(process, "on").mockImplementation(((event: string, fn: () => unknown) => {
      if (event === "SIGTERM" || event === "SIGINT") handlers.set(event, fn);
      return process;
    }) as never);
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
    }) as never);
  });
  afterAll(() => {
    onSpy.mockRestore();
    exitSpy.mockRestore();
    if (prevHealth === undefined) delete process.env.PRODUCER_DISABLE_HEALTH_WORKER;
    else process.env.PRODUCER_DISABLE_HEALTH_WORKER = prevHealth;
  });

  it("aborts the active render, reaps tracked processes, and closes the server", async () => {
    startServer({ port: 0, hostname: "127.0.0.1" });
    const sigterm = handlers.get("SIGTERM");
    expect(sigterm).toBeDefined();
    expect(fetchHandler).toBeDefined();

    const started = new Promise<void>((resolve) => {
      render.started = resolve;
    });
    const response = Promise.resolve(
      fetchHandler!(
        new Request("http://localhost/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ html: "<html></html>" }),
        }),
      ),
    );
    await started;
    expect(render.signal?.aborted).toBe(false);

    await sigterm!();

    expect(render.signal?.aborted).toBe(true);
    expect(calls.killTrackedProcesses).toBe(1);
    expect(calls.drainBrowserPool).toBe(1);
    expect(calls.closeIdle).toBe(1);
    expect(calls.serverClosed).toBe(1);
    expect(exits).toEqual([0]);

    // The in-flight request is answered as a cancellation (503), not left hanging.
    const res = await response;
    expect(res.status).toBe(503);
  });
});
