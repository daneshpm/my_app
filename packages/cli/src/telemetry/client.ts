import type { EventProperties } from "./transport.js";

// ---------------------------------------------------------------------------
// Telemetry is removed from this fork. Every export keeps its original
// signature so call sites compile unchanged, but nothing is collected, queued,
// sent, or shown to the user.
// ---------------------------------------------------------------------------

export { flush, flushSync } from "./transport.js";

/** Always false: telemetry is permanently disabled. */
export function shouldTrack(): boolean {
  return false;
}

/** No-op kept for API compatibility (there is no posture to cache). */
export function resetTelemetryPostureCache(): void {}

/** No-op: events are discarded. */
export function trackEvent(
  _event: string,
  _properties: EventProperties = {},
  _distinctId?: string,
): void {}
