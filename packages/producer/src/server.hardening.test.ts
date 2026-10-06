import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  contentTypeForOutput,
  createProducerApp,
  prepareRenderBody,
  resolveMaxBodyBytes,
  resolveMaxConcurrentRenders,
  resolveRenderTimeoutMs,
  DEFAULT_MAX_BODY_BYTES,
} from "./server";

describe("server limits", () => {
  it("falls back to 2 for an invalid concurrency value", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "", undefined, Number.NaN, 0]) {
      expect(resolveMaxConcurrentRenders(bad)).toBe(2);
    }
    expect(resolveMaxConcurrentRenders("3")).toBe(3);
    expect(resolveMaxConcurrentRenders(4)).toBe(4);
  });

  it("resolves body cap and render deadline with safe defaults", () => {
    expect(resolveMaxBodyBytes(undefined)).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(resolveMaxBodyBytes("nope")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(resolveMaxBodyBytes("1024")).toBe(1024);
    expect(resolveRenderTimeoutMs(undefined)).toBe(0);
    expect(resolveRenderTimeoutMs("-5")).toBe(0);
    expect(resolveRenderTimeoutMs("60000")).toBe(60000);
  });
});

describe("contentTypeForOutput", () => {
  it("derives the content type from the extension", () => {
    expect(contentTypeForOutput("/r/a.mp4")).toBe("video/mp4");
    expect(contentTypeForOutput("/r/a.WEBM")).toBe("video/webm");
    expect(contentTypeForOutput("/r/a.mov")).toBe("video/quicktime");
    expect(contentTypeForOutput("/r/a.gif")).toBe("image/gif");
    expect(contentTypeForOutput("/r/a.png")).toBe("image/png");
    expect(contentTypeForOutput("/r/a.bin")).toBe("application/octet-stream");
  });
});

describe("request body limit", () => {
  const original = process.env.PRODUCER_MAX_BODY_BYTES;
  afterEach(() => {
    if (original === undefined) delete process.env.PRODUCER_MAX_BODY_BYTES;
    else process.env.PRODUCER_MAX_BODY_BYTES = original;
  });

  it("rejects an oversized render body with 413", async () => {
    process.env.PRODUCER_MAX_BODY_BYTES = "100";
    const app = createProducerApp();
    const body = JSON.stringify({ html: "x".repeat(500) });
    for (const path of ["/render", "/render/stream", "/lint"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        body,
      });
      expect(res.status).toBe(413);
    }
  });
});

describe("previewUrl SSRF guard", () => {
  it("rejects non-public or non-https previewUrl without fetching", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response("<html></html>"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      for (const previewUrl of [
        "http://127.0.0.1:8080/x.html",
        "https://169.254.169.254/latest/meta-data/",
        "http://example.com/x.html",
      ]) {
        const result = await prepareRenderBody({ previewUrl });
        expect("error" in result).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still fetches a legitimate https previewUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response("<html><body>ok</body></html>"),
    ) as unknown as typeof fetch;
    try {
      const result = await prepareRenderBody({ previewUrl: "https://example.com/p.html" });
      expect("error" in result).toBe(false);
      if (!("error" in result) && result.prepared.cleanupProjectDir) {
        const { rmSync } = await import("node:fs");
        rmSync(result.prepared.cleanupProjectDir, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
