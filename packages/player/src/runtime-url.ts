/**
 * Where the runtime comes from.
 *
 * Split out of composition-probe so the probe's late injection and the srcdoc's
 * parse-time injection cannot drift onto different URLs.
 */
declare const __TAGREEL_RUNTIME_CDN_URL__: string;

export function runtimeCdnUrlForVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Tagreel runtime version: ${version}`);
  }
  return `https://cdn.jsdelivr.net/npm/@tagreel/core@${version}/dist/tagreel.runtime.iife.js`;
}

export const RUNTIME_CDN_URL =
  typeof __TAGREEL_RUNTIME_CDN_URL__ === "string"
    ? __TAGREEL_RUNTIME_CDN_URL__
    : runtimeCdnUrlForVersion("0.0.0-dev");
