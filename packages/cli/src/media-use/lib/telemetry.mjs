// Usage tracking is removed from this fork. `track` is kept as a no-op so the
// media-use scripts that call it keep working unchanged: nothing is sent over
// the network, no identity is read or minted, and no notice is printed.

/**
 * No-op. Resolves immediately without any network, filesystem, or console
 * activity. `properties` is accepted and ignored.
 */
export async function track(_event, _properties = {}) {}
