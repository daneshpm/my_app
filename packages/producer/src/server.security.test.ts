import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProducerApp,
  isAuthorizedBearer,
  prepareRenderBody,
  shouldRestrictExternalAssets,
} from "./server";

describe("producer bearer auth", () => {
  const original = process.env.PRODUCER_AUTH_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.PRODUCER_AUTH_TOKEN;
    else process.env.PRODUCER_AUTH_TOKEN = original;
  });

  it("checks the Authorization header", () => {
    expect(isAuthorizedBearer("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorizedBearer("bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorizedBearer("Bearer wrong", "s3cret")).toBe(false);
    expect(isAuthorizedBearer("Bearer s3cret-longer", "s3cret")).toBe(false);
    expect(isAuthorizedBearer("Basic s3cret", "s3cret")).toBe(false);
    expect(isAuthorizedBearer(undefined, "s3cret")).toBe(false);
  });

  it("is off when no token is configured", async () => {
    delete process.env.PRODUCER_AUTH_TOKEN;
    const res = await createProducerApp().request("/render/queue");
    expect(res.status).toBe(200);
  });

  it("401s every route but /health when PRODUCER_AUTH_TOKEN is set", async () => {
    process.env.PRODUCER_AUTH_TOKEN = "s3cret";
    const app = createProducerApp();
    expect((await app.request("/health")).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/render/queue"],
      ["GET", "/outputs/abc"],
      ["POST", "/render"],
      ["POST", "/render/stream"],
      ["POST", "/lint"],
    ] as const) {
      const res = await app.request(path, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status).toBe(401);
    }
    const bad = await app.request("/render/queue", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const ok = await app.request("/render/queue", { headers: { authorization: "Bearer s3cret" } });
    expect(ok.status).toBe(200);
  });

  it("accepts an authToken option over the environment", async () => {
    delete process.env.PRODUCER_AUTH_TOKEN;
    const app = createProducerApp({ authToken: "opt" });
    expect((await app.request("/render/queue")).status).toBe(401);
    const ok = await app.request("/render/queue", { headers: { authorization: "Bearer opt" } });
    expect(ok.status).toBe(200);
  });
});

describe("entryFile containment", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "producer-entry-"));
    dirs.push(root);
    const dir = join(root, "proj");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "sub", "scene.html"), "<html></html>");
    writeFileSync(join(root, "outside.html"), "<html></html>");
    return dir;
  }

  it("accepts entry files inside the project", async () => {
    const dir = project();
    expect("error" in (await prepareRenderBody({ projectDir: dir }))).toBe(false);
    expect(
      "error" in (await prepareRenderBody({ projectDir: dir, entryFile: "sub/scene.html" })),
    ).toBe(false);
  });

  it("rejects traversal and absolute entry files that exist", async () => {
    const dir = project();
    for (const entryFile of [
      "../outside.html",
      join(dir, "..", "outside.html"),
      "sub/../../outside.html",
    ]) {
      const result = await prepareRenderBody({ projectDir: dir, entryFile });
      expect(result).toEqual({
        error: expect.stringContaining("Entry file must stay inside project directory"),
      });
    }
  });

  it("rejects an entry symlink that points outside the project", async () => {
    const dir = project();
    try {
      symlinkSync(join(dir, "..", "outside.html"), join(dir, "link.html"), "file");
    } catch {
      return; // symlinks need privileges on Windows
    }
    const result = await prepareRenderBody({ projectDir: dir, entryFile: "link.html" });
    expect(result).toEqual({
      error: expect.stringContaining("Entry file must stay inside project directory"),
    });
  });
});

describe("shouldRestrictExternalAssets", () => {
  it("defaults to restricted for inline projects only", () => {
    expect(shouldRestrictExternalAssets(true, undefined)).toBe(true);
    expect(shouldRestrictExternalAssets(false, undefined)).toBe(false);
  });

  it("is overridden by PRODUCER_RESTRICT_EXTERNAL_ASSETS", () => {
    expect(shouldRestrictExternalAssets(false, "1")).toBe(true);
    expect(shouldRestrictExternalAssets(false, "true")).toBe(true);
    expect(shouldRestrictExternalAssets(true, "0")).toBe(false);
    expect(shouldRestrictExternalAssets(true, "false")).toBe(false);
  });
});
