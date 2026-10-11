// ---------------------------------------------------------------------------
// Studio browser telemetry client — intentionally inert. This fork sends no
// analytics: no network request, no beacon, no queue, no console notice. The
// exports keep their signatures so call sites compile unchanged.
// ---------------------------------------------------------------------------

type EventProperties = Record<string, string | number | boolean | undefined>;

/** Always false: telemetry is permanently disabled. */
export function shouldTrack(): boolean {
  return false;
}

/** No-op: events are discarded. */
export function trackEvent(_event: string, _properties: EventProperties = {}): void {}
