// Legacy `studio:*` event API — intentionally inert. This fork sends no
// analytics: no network request, no beacon, no queue. Signatures are kept so
// call sites compile unchanged.

interface EventProperties {
  [key: string]: string | number | boolean | null | undefined;
}

/** No-op: events are discarded. */
export function trackStudioEvent(_event: string, _properties: EventProperties = {}): void {}

/** No-op: there is never a queue to drain. */
export function flushViaBeacon(): void {}
