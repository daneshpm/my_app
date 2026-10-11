import { afterEach, describe, expect, it, vi } from "vitest";
import { isSafeVersion, printDeprecationNotice, withMeta } from "./updateCheck.js";

describe("isSafeVersion", () => {
  it("accepts strict semver, incl. prerelease/build metadata", () => {
    expect(isSafeVersion("1.2.3")).toBe(true);
    expect(isSafeVersion("0.7.28")).toBe(true);
    expect(isSafeVersion("1.2.3-beta.1")).toBe(true);
    expect(isSafeVersion("1.2.3+build.5")).toBe(true);
  });

  it("rejects anything that could carry shell metacharacters or isn't semver", () => {
    expect(isSafeVersion("")).toBe(false);
    expect(isSafeVersion("latest")).toBe(false);
    expect(isSafeVersion("1.2")).toBe(false);
    expect(isSafeVersion("1.2.3; rm -rf /")).toBe(false);
    expect(isSafeVersion("1.2.3 && curl evil")).toBe(false);
    expect(isSafeVersion("$(whoami)")).toBe(false);
  });
});

/**
 * Drive printUpdateNotice under controlled mocks. isDevMode() is true under
 * vitest (the module path ends in .ts), which would suppress the notice, so we
 * mock ./env.js. detectInstaller and readConfig are mocked to pick the branch.
 */
async function noticeWith(opts: {
  installerCommand: string | null;
  latestVersion?: string;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
}): Promise<string> {
  vi.resetModules();
  vi.doMock("./env.js", () => ({ isDevMode: () => false }));
  vi.doMock("./installerDetection.js", () => ({
    detectInstaller: () => ({
      kind: opts.installerCommand ? "npm" : "skip",
      installCommand: () => opts.installerCommand,
      reason: "test",
    }),
  }));
  vi.doMock("../telemetry/config.js", () => ({
    readConfig: () => ({ latestVersion: opts.latestVersion ?? "9.9.9" }),
    writeConfig: () => {},
  }));

  const origEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Default to a non-CI interactive terminal unless the test overrides env.
  for (const name of ["CI", "TAGREEL_NO_UPDATE_CHECK"]) {
    if (!(name in (opts.env ?? {}))) delete process.env[name];
  }

  const origTTY = process.stderr.isTTY;
  Object.defineProperty(process.stderr, "isTTY", {
    value: opts.isTTY ?? true,
    configurable: true,
  });
  const writes: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const mod = await import("./updateCheck.js");
    mod.printUpdateNotice();
  } finally {
    process.stderr.write = origWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: origTTY, configurable: true });
    process.env = origEnv;
  }
  return writes.join("");
}

describe("printUpdateNotice — install-method-aware command", () => {
  afterEach(() => {
    vi.doUnmock("./env.js");
    vi.doUnmock("./installerDetection.js");
    vi.doUnmock("../telemetry/config.js");
    vi.resetModules();
  });

  it("shows the detected manager's command for an owned global install", async () => {
    const out = await noticeWith({ installerCommand: "brew upgrade tagreel" });
    expect(out).toContain("Update available");
    expect(out).toContain("brew upgrade tagreel");
    expect(out).not.toContain("npx tagreel@latest");
  });

  it("falls back to npx tagreel@latest when the install method is skip/unknown", async () => {
    const out = await noticeWith({ installerCommand: null });
    expect(out).toContain("npx tagreel@latest");
  });

  it("is suppressed on a non-TTY stderr", async () => {
    const out = await noticeWith({ installerCommand: "brew upgrade tagreel", isTTY: false });
    expect(out).toBe("");
  });

  it("is suppressed in CI", async () => {
    const out = await noticeWith({
      installerCommand: "brew upgrade tagreel",
      env: { CI: "true" },
    });
    expect(out).toBe("");
  });

  it("is suppressed by the TAGREEL_NO_UPDATE_CHECK opt-out", async () => {
    const out = await noticeWith({
      installerCommand: "brew upgrade tagreel",
      env: { TAGREEL_NO_UPDATE_CHECK: "1" },
    });
    expect(out).toBe("");
  });
});

/**
 * U5: validate/inspect/layout are deprecated in favor of `check`. withMeta's
 * optional `{ deprecated: true }` is the single place that adds `_meta.deprecated`
 * to a --json envelope; every other command (check, lint, ...) calls withMeta
 * with no second argument and must never see the key at all — not even `false`.
 */
describe("withMeta — deprecated flag", () => {
  it("omits _meta.deprecated entirely when no options are passed (check/lint et al.)", () => {
    const wrapped = withMeta({ ok: true });
    expect("deprecated" in wrapped._meta).toBe(false);
  });

  it("omits _meta.deprecated when options.deprecated is false", () => {
    const wrapped = withMeta({ ok: true }, { deprecated: false });
    expect("deprecated" in wrapped._meta).toBe(false);
  });

  it("sets _meta.deprecated === true when requested (validate/inspect/layout)", () => {
    const wrapped = withMeta({ ok: true }, { deprecated: true });
    expect(wrapped._meta.deprecated).toBe(true);
  });

  it("preserves the rest of the _meta envelope alongside the deprecated flag", () => {
    const wrapped = withMeta({ ok: true }, { deprecated: true });
    expect(wrapped._meta.version).toEqual(expect.any(String));
    expect(typeof wrapped._meta.updateAvailable).toBe("boolean");
  });
});

/**
 * The stderr-only deprecation notice: printed once per invocation, never on
 * stdout, so --json output stays pure JSON while humans still see the notice.
 */
describe("printDeprecationNotice", () => {
  it("writes exactly one line to stderr, never stdout", () => {
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const origErrWrite = process.stderr.write.bind(process.stderr);
    const origOutWrite = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      printDeprecationNotice("validate");
    } finally {
      process.stderr.write = origErrWrite;
      process.stdout.write = origOutWrite;
    }

    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites).toHaveLength(1);
    expect(stderrWrites[0]).toContain("tagreel validate");
    expect(stderrWrites[0]).toContain("tagreel check");
  });
});

describe("checkForUpdate — remote version checks are disabled", () => {
  afterEach(() => {
    vi.doUnmock("../telemetry/config.js");
    vi.doUnmock("./env.js");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("never touches the network, even when forced, and never writes config", async () => {
    vi.resetModules();
    vi.doMock("./env.js", () => ({ isDevMode: () => false }));
    const writes: unknown[] = [];
    vi.doMock("../telemetry/config.js", () => ({
      readConfig: () => ({}),
      readConfigFresh: () => ({}),
      writeConfig: (c: unknown) => writes.push(c),
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const mod = await import("./updateCheck.js");
      const result = await mod.checkForUpdate(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(result.updateAvailable).toBe(false);
      expect(result.latest).toBe(result.current);
      expect(mod.updateCheckDue()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("cachedUpdateCheck — what the parent reads without fetching", () => {
  afterEach(() => {
    vi.doUnmock("../telemetry/config.js");
    vi.doUnmock("./env.js");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function load(config: Record<string, unknown>) {
    vi.resetModules();
    vi.stubEnv("CI", "");
    vi.stubEnv("TAGREEL_NO_UPDATE_CHECK", "");
    vi.doMock("./env.js", () => ({ isDevMode: () => false }));
    vi.doMock("../telemetry/config.js", () => ({
      readConfig: () => ({ ...config }),
      readConfigFresh: () => ({ ...config }),
      writeConfig: () => {},
    }));
    return import("./updateCheck.js");
  }

  it("reports a cached newer version, and never surfaces an unsafe one", async () => {
    expect((await load({ latestVersion: "999.0.0" })).cachedUpdateCheck()).toMatchObject({
      latest: "999.0.0",
      updateAvailable: true,
    });
    const poisoned = (await load({ latestVersion: "999.0.0; rm -rf /" })).cachedUpdateCheck();
    expect(poisoned.updateAvailable).toBe(false);
    expect(poisoned.latest).not.toContain(";");
  });
});
