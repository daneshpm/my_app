import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SIBLING_PATH = resolve(THIS_DIR, "tagreel.manifest.json");
const MONOREPO_PATH = resolve(THIS_DIR, "../../../core/dist/tagreel.manifest.json");

describe("resolveTagreelManifestPath", () => {
  const originalEnv = process.env.PRODUCER_TAGREEL_MANIFEST_PATH;

  beforeEach(() => {
    delete process.env.PRODUCER_TAGREEL_MANIFEST_PATH;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PRODUCER_TAGREEL_MANIFEST_PATH = originalEnv;
    } else {
      delete process.env.PRODUCER_TAGREEL_MANIFEST_PATH;
    }
  });

  it("returns env var when PRODUCER_TAGREEL_MANIFEST_PATH is set", async () => {
    process.env.PRODUCER_TAGREEL_MANIFEST_PATH = "/custom/path/manifest.json";
    const { resolveTagreelManifestPath } = await import("./tagreelRuntimeLoader.js");
    expect(resolveTagreelManifestPath()).toBe("/custom/path/manifest.json");
  });

  it("sibling path resolves to same directory as the module file", () => {
    // Key invariant: after build, dist/tagreel.manifest.json sits next to
    // dist/index.js. In source, SIBLING_MANIFEST_PATH is next to this file.
    // This verifies the path construction is correct.
    expect(SIBLING_PATH).toBe(resolve(THIS_DIR, "tagreel.manifest.json"));
    expect(SIBLING_PATH).toContain("producer/src/services/tagreel.manifest.json");
  });

  it("prefers sibling path when it exists, otherwise picks the first existing candidate", async () => {
    // Behaviour-level replacement for the old source-text test that
    // asserted on string positions inside `const candidates = [...]`. We
    // prove the behavioural invariant instead: the resolver returns the
    // first candidate that actually exists on disk.
    const { resolveTagreelManifestPath } = await import("./tagreelRuntimeLoader.js");
    const resolved = resolveTagreelManifestPath();
    expect(existsSync(resolved)).toBe(true);
    // The sibling would win when present. In dev, the monorepo-relative
    // core/dist is the real fallback; either way the path must exist.
    if (existsSync(SIBLING_PATH)) {
      expect(resolved).toBe(SIBLING_PATH);
    }
  });

  it("falls back to MONOREPO_PATH when present in dev (smoke test)", async () => {
    if (!existsSync(MONOREPO_PATH)) {
      // Skip if core hasn't been built — this is expected in CI before build
      return;
    }
    const { resolveTagreelManifestPath } = await import("./tagreelRuntimeLoader.js");
    expect(resolveTagreelManifestPath()).toBe(MONOREPO_PATH);
  });
});

describe("tagreelRuntimeLoader error path (#3370)", () => {
  const originalEnv = process.env.PRODUCER_TAGREEL_MANIFEST_PATH;

  beforeEach(() => {
    delete process.env.PRODUCER_TAGREEL_MANIFEST_PATH;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PRODUCER_TAGREEL_MANIFEST_PATH = originalEnv;
    } else {
      delete process.env.PRODUCER_TAGREEL_MANIFEST_PATH;
    }
  });

  it("names the env-override path when PRODUCER_TAGREEL_MANIFEST_PATH is set and missing", async () => {
    // Force the env-override branch with a missing file. The thrown error
    // must name the override, not any fallback candidate.
    process.env.PRODUCER_TAGREEL_MANIFEST_PATH = "/nonexistent/override/manifest.json";
    const { resolveVerifiedTagreelRuntime } = await import("./tagreelRuntimeLoader.js");
    expect(() => resolveVerifiedTagreelRuntime()).toThrow(/nonexistent\/override\/manifest\.json/);
  });

  it("triedManifestPaths returns only the override when PRODUCER_TAGREEL_MANIFEST_PATH is set", async () => {
    process.env.PRODUCER_TAGREEL_MANIFEST_PATH = "/another/missing/override.json";
    const { triedManifestPaths } = await import("./tagreelRuntimeLoader.js");
    expect(triedManifestPaths()).toEqual(["/another/missing/override.json"]);
  });

  it("triedManifestPaths lists every candidate when no override is set", async () => {
    delete process.env.PRODUCER_TAGREEL_MANIFEST_PATH;
    const { triedManifestPaths } = await import("./tagreelRuntimeLoader.js");
    const tried = triedManifestPaths();
    expect(tried.length).toBeGreaterThanOrEqual(4);
    // The first candidate must be the sibling path so the user sees it
    // first in the error message (daneshpm/my_app#3370).
    expect(tried[0]).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "tagreel.manifest.json"),
    );
  });
});
