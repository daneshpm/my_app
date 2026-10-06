import { hostname as osHostname, networkInterfaces } from "node:os";

/**
 * DNS-rebinding defence for the studio API.
 *
 * A remote page can point a hostname it controls at 127.0.0.1 and then read
 * (or write) the preview API as "same-origin". A browser cannot forge `Host`,
 * so refusing any Host that is not one of our own names stops that attack
 * for every route, GETs included.
 */

export interface HostPolicy {
  /** Bind host (`HYPERFRAMES_PREVIEW_HOST`). Unset/loopback means loopback-only. */
  bindHost?: string;
  /** Explicit extra hostnames (`HYPERFRAMES_PREVIEW_ALLOWED_HOSTS`). */
  allowedHosts?: readonly string[];
  /** Names this machine answers to; injectable for tests. */
  localNames?: () => ReadonlySet<string>;
}

/** Hostname of a `Host` header, port and IPv6 brackets removed, lowercased. */
export function hostnameOfHostHeader(host: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed) return (bracketed[1] ?? "").toLowerCase();
  return (host.split(":")[0] ?? "").toLowerCase().replace(/\.$/, "");
}

export function isLoopbackHostname(name: string): boolean {
  if (name === "localhost") return true;
  if (name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function isWildcardBind(bind: string): boolean {
  return bind === "0.0.0.0" || bind === "::" || bind === "*";
}

/** Every interface address plus this machine's hostname forms. Fails closed. */
export function machineLocalNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) names.add(entry.address.toLowerCase());
    }
    const self = osHostname().toLowerCase();
    if (self !== "") {
      names.add(self);
      names.add(`${self}.local`);
      const short = self.split(".")[0];
      if (short) {
        names.add(short);
        names.add(`${short}.local`);
      }
    }
  } catch {
    /* fail closed */
  }
  return names;
}

/**
 * Is a request carrying this `Host` header addressed to us?
 *
 * A missing Host is allowed: browsers always send one, and in-process callers
 * (tests, adapters) legitimately have none.
 */
export function isAllowedHost(host: string | undefined, policy: HostPolicy = {}): boolean {
  if (host === undefined || host.trim() === "") return true;
  const requested = hostnameOfHostHeader(host.trim());
  if (requested === "") return false;
  if (isLoopbackHostname(requested)) return true;

  const extra = (policy.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(requested)) return true;

  const bind = (policy.bindHost ?? "").trim().toLowerCase();
  if (bind === "" || isLoopbackHostname(hostnameOfHostHeader(bind))) return false;
  const bound = hostnameOfHostHeader(bind);
  if (requested === bound) return true;
  if (isWildcardBind(bind)) return (policy.localNames ?? machineLocalNames)().has(requested);
  return false;
}

/** Policy from the process environment, read per call so env changes apply. */
export function hostPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): HostPolicy {
  return {
    bindHost: env["HYPERFRAMES_PREVIEW_HOST"],
    allowedHosts: (env["HYPERFRAMES_PREVIEW_ALLOWED_HOSTS"] ?? "").split(","),
  };
}
