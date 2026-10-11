export type TelemetryStatusSource = "telemetry_removed";

export type TelemetryStatus = {
  enabled: boolean;
  source: TelemetryStatusSource;
};

/**
 * Telemetry is permanently removed from this fork, so the runtime override is
 * unconditional. Kept as a function so existing callers need no changes.
 */
export function telemetryRuntimeOverride(): TelemetryStatusSource {
  return "telemetry_removed";
}

/** Effective status: always disabled, regardless of persisted config. */
export function effectiveTelemetryStatus(_configEnabled: boolean): TelemetryStatus {
  return { enabled: false, source: "telemetry_removed" };
}
