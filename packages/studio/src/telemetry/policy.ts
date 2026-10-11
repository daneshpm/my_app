// ---------------------------------------------------------------------------
// Browser telemetry policy. Telemetry is removed from this fork, so no browser
// profile may ever be measured: no event is sent, no canary cohort is enrolled,
// and no feedback prompt is shown. Callers keep asking this one question, so
// the answer is a constant instead of touching every call site.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __HF_CLI_TELEMETRY_DISABLED?: boolean;
  }
}

/** Always false: telemetry is permanently disabled. */
export function browserTelemetryAllowed(): boolean {
  return false;
}
