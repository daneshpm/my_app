import { buildTagreelRuntimeScript } from "./tagreelRuntime.engine";
import { TAGREEL_BRIDGE_SOURCES, TAGREEL_RUNTIME_GLOBALS } from "./runtimeContract";

export const TAGREEL_RUNTIME_ARTIFACTS = {
  iife: "tagreel.runtime.iife.js",
  esm: "tagreel.runtime.mjs",
  manifest: "tagreel.manifest.json",
} as const;

export type TagreelRuntimeContract = {
  globals: typeof TAGREEL_RUNTIME_GLOBALS;
  messageSources: typeof TAGREEL_BRIDGE_SOURCES;
};

export const TAGREEL_RUNTIME_CONTRACT: TagreelRuntimeContract = {
  globals: TAGREEL_RUNTIME_GLOBALS,
  messageSources: TAGREEL_BRIDGE_SOURCES,
};

export function loadTagreelRuntimeSource(): string | null {
  return buildTagreelRuntimeScript();
}
