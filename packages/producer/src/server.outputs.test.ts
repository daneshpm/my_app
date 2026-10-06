import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// The render itself is not under test: the stubbed orchestrator just produces the
// artifact (file or directory) so the route can hand out an /outputs token for it.
type Produce = (outputPath: string) => void;
const state: { produce: Produce; failStream: boolean } = {
  produce: () => {},
  failStream: false,
};

const realOrchestrator = await import("./services/renderOrchestrator.js");
mock.module("./services/renderOrchestrator.js", () => ({
  ...realOrchestrator,
  executeRenderJob: async (_job: unknown, _dir: string, outputPath: string) => {
    state.produce(outputPath);
  },
}));
// Snapshot first: after mock.module the namespace import resolves to the mock itself.
const fsSnapshot = { ...realFs };
mock.module("node:fs", () => ({
  ...fsSnapshot,
  createReadStream: (path: string, opts?: Parameters<typeof realFs.createReadStream>[1]) =>
    state.failStream
      ? new Readable({
          read() {
            this.destroy(new Error("disk read failed"));
          },
        })
      : fsSnapshot.createReadStream(path, opts),
}));

const { createProducerApp } = await import("./server");

describe("GET /outputs/:token", () => {
  let rendersDir: string;
  let app: ReturnType<typeof createProducerApp>;

  beforeAll(() => {
    delete process.env.PRODUCER_AUTH_TOKEN;
    rendersDir = mkdtempSync(join(tmpdir(), "producer-outputs-"));
    app = createProducerApp({ rendersDir });
  });
  afterAll(() => rmSync(rendersDir, { recursive: true, force: true }));
  afterEach(() => {
    state.failStream = false;
  });

  async function renderTo(name: string, format: string, produce: Produce): Promise<string> {
    state.produce = produce;
    const res = await app.request("/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        html: "<html></html>",
        outputPath: join(rendersDir, name),
        format,
      }),
    });
    const json = (await res.json()) as { success: boolean; outputToken?: string; error?: string };
    expect(json.success).toBe(true);
    return json.outputToken as string;
  }

  it("serves each artifact with a content-type derived from its extension", async () => {
    for (const [name, format, type] of [
      ["a.mp4", "mp4", "video/mp4"],
      ["b.webm", "webm", "video/webm"],
      ["c.mov", "mov", "video/quicktime"],
    ] as const) {
      const token = await renderTo(name, format, (p) => writeFileSync(p, "bytes-" + name));
      const res = await app.request(`/outputs/${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("bytes-" + name);
    }
  });

  it("404s an unknown token", async () => {
    const res = await app.request("/outputs/nope");
    expect(res.status).toBe(404);
  });

  it("404s a directory output (png-sequence / hls) instead of streaming it", async () => {
    const token = await renderTo("seq.mp4", "mp4", (p) => mkdirSync(p, { recursive: true }));
    const res = await app.request(`/outputs/${token}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Output artifact is not a single file" });
  });

  it("404s and forgets a token whose file has disappeared", async () => {
    const token = await renderTo("gone.mp4", "mp4", (p) => writeFileSync(p, "x"));
    rmSync(join(rendersDir, "gone.mp4"));
    expect((await app.request(`/outputs/${token}`)).status).toBe(404);
    expect((await app.request(`/outputs/${token}`)).status).toBe(404);
  });

  it("errors the response body when the read stream fails", async () => {
    const token = await renderTo("bad.mp4", "mp4", (p) => writeFileSync(p, "payload"));
    state.failStream = true;
    const res = await app.request(`/outputs/${token}`);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});
