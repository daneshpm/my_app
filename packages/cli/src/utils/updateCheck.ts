import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "compare-versions";
import { readConfig, readConfigFresh, writeConfig } from "../telemetry/config.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { isDevMode } from "./env.js";
import { detectInstaller } from "./installerDetection.js";
import { readPinnedTagreelVersions } from "./projectPin.js";
import { isSafeVersion } from "./safeVersion.js";

export { isSafeVersion } from "./safeVersion.js";

/** Returns true if `a` is newer than `b` per semver (handles alpha, beta, rc). */
function isNewerSemver(a: string, b: string): boolean {
  try {
    return compareVersions(a, b) > 0;
  } catch {
    return a !== b;
  }
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface UpdateMeta {
  version: string;
  latestVersion?: string;
  updateAvailable: boolean;
  /** Present (and true) only for commands superseded by `check`; absent otherwise. */
  deprecated?: boolean;
}

/**
 * Version check, intentionally a no-op: the CLI no longer contacts the npm
 * registry. It reports the running version (or a previously cached one) and
 * never touches the network. The package name comes from package.json via
 * PACKAGE_NAME, so a later rename needs no change here.
 *
 * @param _force - Accepted for API compatibility; ignored.
 */
export async function checkForUpdate(_force?: boolean): Promise<UpdateCheckResult> {
  return fallbackResult(readConfig().latestVersion);
}

/** Whether the background check should ask a registry. Always false: remote version checks are disabled. */
export function updateCheckDue(_config = readConfig()): boolean {
  // No remote version source is configured, so a check is never due.
  return false;
}

export function cachedUpdateCheck(): UpdateCheckResult {
  return fallbackResult(readConfig().latestVersion);
}

function fallbackResult(cachedLatest?: string): UpdateCheckResult {
  // Only surface a cached version we can prove is safe — a pre-existing
  // poisoned cache must not leak through the fallback path either.
  const safeCached = cachedLatest && isSafeVersion(cachedLatest) ? cachedLatest : undefined;
  return {
    current: VERSION,
    latest: safeCached ?? VERSION,
    updateAvailable: safeCached ? isNewerSemver(safeCached, VERSION) : false,
  };
}

/**
 * Synchronous read from cache — for _meta envelope on --json commands.
 * Never fetches. Returns what the last background check found.
 */
export function getUpdateMeta(): UpdateMeta {
  const config = readConfig();
  return {
    version: VERSION,
    latestVersion: config.latestVersion,
    updateAvailable: config.latestVersion ? isNewerSemver(config.latestVersion, VERSION) : false,
  };
}

/**
 * Wrap a JSON payload with the _meta version envelope.
 * Use this in all --json command outputs for consistent agent-friendly metadata.
 *
 * Pass `{ deprecated: true }` from a command superseded by `check` (validate,
 * inspect, layout) to add `_meta.deprecated: true`; every other call site is
 * unaffected — the key is only ever added, never set to `false`.
 */
export function withMeta<T extends object>(
  data: T,
  options?: { deprecated?: boolean },
): T & { _meta: UpdateMeta } {
  const meta = getUpdateMeta();
  if (options?.deprecated) meta.deprecated = true;
  return { ...data, _meta: meta };
}

/**
 * One-line deprecation notice for a command superseded by `check`. Always
 * writes to stderr (never stdout), so a --json invocation's stdout stays
 * pure, parseable JSON. Call once per invocation, before the command's own
 * output.
 */
export function printDeprecationNotice(command: string): void {
  process.stderr.write(
    `'tagreel ${command}' is deprecated and will be removed in a future release. Use 'tagreel check' instead.\n`,
  );
}

/** True when the update check is off: dev mode, CI, or the TAGREEL_NO_UPDATE_CHECK opt-out. */
export function updateCheckDisabled(): boolean {
  if (isDevMode()) return true;
  if (process.env["CI"] === "true" || process.env["CI"] === "1") return true;
  return process.env["TAGREEL_NO_UPDATE_CHECK"] === "1";
}

/**
 * True when update / freshness notices should stay silent: the check is off or stderr is not a
 * terminal. Shared with the skills freshness notice so both honour the same gating.
 */
export function updateNoticesSuppressed(): boolean {
  return updateCheckDisabled() || !process.stderr.isTTY;
}

/**
 * Print update notice to stderr if a newer version is available.
 * Skipped in CI, non-TTY, dev mode, or when TAGREEL_NO_UPDATE_CHECK is set.
 */
export function printUpdateNotice(): void {
  if (updateNoticesSuppressed()) return;

  const meta = getUpdateMeta();
  if (!meta.updateAvailable || !meta.latestVersion) return;

  // Show the command that updates *this* install: the detected package
  // manager's upgrade for owned global installs (npm/bun/pnpm/brew), and the
  // universal `npx tagreel@latest` for ephemeral/unknown installs (where a
  // manager command wouldn't apply). detectInstaller() only runs here, after
  // the suppression + update-available gates, so it adds no cost to normal runs.
  const safeLatest = isSafeVersion(meta.latestVersion);
  const managerCommand = safeLatest ? detectInstaller().installCommand(meta.latestVersion) : null;
  const command = managerCommand ?? `npx ${PACKAGE_NAME}@latest`;

  process.stderr.write(
    `\n  Update available: ${meta.version} \u2192 ${meta.latestVersion}\n` +
      `  Run: ${command}\n\n`,
  );
}

const STALE_PIN_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Actionable notice when the running CLI is older than the project's pin (every
 * run), or when the pin is older than the latest release (once/24h per install).
 * Unlike printUpdateNotice this DOES fire on non-TTY (agents render with piped
 * stderr), but never under --json/CI/dev/opt-out: the whole cli.ts update block
 * is skipped for --json, so a JSON stdout stays clean regardless.
 */
export function printStalePinNotice(cwd: string = process.cwd()): void {
  if (updateCheckDisabled()) return;

  let scripts: Record<string, string> = {};
  try {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) return;
    scripts = (JSON.parse(readFileSync(pkgPath, "utf-8")).scripts ?? {}) as Record<string, string>;
  } catch {
    return;
  }
  const pins = readPinnedTagreelVersions(scripts);
  // A CLI older than the pin (e.g. a stale npx cache) misjudges every run, so this is never throttled.
  const newerPins = pins.filter((v) => isNewerSemver(v, VERSION)).sort(compareVersions);
  if (newerPins.length > 0) {
    process.stderr.write(
      `\n  This is tagreel ${VERSION}, but this project pins tagreel@${newerPins.join(", ")}.\n` +
        `  Run it through the project's npm scripts, or npx ${PACKAGE_NAME}@${newerPins.at(-1)}.\n\n`,
    );
    return;
  }

  const latest = getUpdateMeta().latestVersion;
  if (!latest || !isSafeVersion(latest)) return;
  const stale = pins.filter((v) => {
    try {
      return compareVersions(latest, v) > 0;
    } catch {
      return false;
    }
  });
  if (stale.length === 0) return;

  const last = readConfig().lastStalePinNoticeAt ?? 0;
  if (Date.now() - last < STALE_PIN_THROTTLE_MS) return;
  const config = readConfigFresh();
  config.lastStalePinNoticeAt = Date.now();
  writeConfig(config);

  process.stderr.write(
    `\n  This project pins tagreel@${stale.join(", ")} (latest ${latest}).\n` +
      `  Bump it: npx ${PACKAGE_NAME}@latest upgrade --project\n\n`,
  );
}
