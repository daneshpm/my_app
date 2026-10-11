// ---------------------------------------------------------------------------
// Telemetry transport — intentionally inert. This fork sends no analytics: no
// network request, no spawned child process, no queue. The types and function
// signatures are kept so existing call sites compile unchanged.
// ---------------------------------------------------------------------------

// Scalars, string arrays and numeric maps: the shapes event call sites pass.
export type EventPropertyValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly string[]
  | Readonly<Record<string, number>>;

export interface EventProperties {
  [key: string]: EventPropertyValue;
}

/** No-op: events are discarded, never queued. */
export function enqueue(_event: string, _properties: EventProperties, _distinctId?: string): void {}

/** No-op: nothing is ever sent. */
export async function flush(): Promise<void> {}

/** No-op: nothing is ever sent. */
export function flushSync(): void {}
