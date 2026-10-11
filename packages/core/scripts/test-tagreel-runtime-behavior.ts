import { buildTagreelRuntimeScript } from "../src/inline-scripts/tagreelRuntime.engine";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const baseline = buildTagreelRuntimeScript();
assert(baseline !== null, "buildTagreelRuntimeScript() returned null — entry.ts not found");
const parityEnabled = buildTagreelRuntimeScript({ defaultParityMode: true });
assert(parityEnabled !== null, "Parity-enabled build returned null");
const parityDisabled = buildTagreelRuntimeScript({ defaultParityMode: false });
assert(parityDisabled !== null, "Parity-disabled build returned null");
const withSourceUrl = buildTagreelRuntimeScript({
  sourceUrl: "tagreel.runtime.iife.js",
});
assert(withSourceUrl !== null, "Build with sourceUrl returned null");

assert(baseline.includes("window.__player"), "Baseline runtime should include player contract");
assert(parityEnabled.length > 0, "Parity-enabled build should produce non-empty runtime source");
assert(parityDisabled.length > 0, "Parity-disabled build should produce non-empty runtime source");
assert(
  withSourceUrl.includes("//# sourceURL=tagreel.runtime.iife.js"),
  "Build with sourceUrl should append sourceURL comment",
);

console.log(
  JSON.stringify({
    event: "tagreel_runtime_behavior_verified",
    baselineBytes: baseline.length,
    parityEnabledBytes: parityEnabled.length,
    parityDisabledBytes: parityDisabled.length,
    sourceUrlBytes: withSourceUrl.length,
  }),
);
