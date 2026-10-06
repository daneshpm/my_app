// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hostPolicyFromEnv, hostnameOfHostHeader, isAllowedHost } from "./hostAllowlist.js";
import { createStudioApi } from "../createStudioApi.js";
import type { StudioApiAdapter } from "../types.js";

const lan = () => new Set(["192.168.1.20", "my-box", "my-box.local"]);

describe("isAllowedHost", () => {
  it("parses hostnames with ports and IPv6 brackets", () => {
    expect(hostnameOfHostHeader("LocalHost:3002")).toBe("localhost");
    expect(hostnameOfHostHeader("[::1]:3002")).toBe("::1");
  });

  it("allows loopback names on any port by default", () => {
    for (const h of ["localhost", "localhost:3002", "127.0.0.1:80", "[::1]:3002", "127.5.5.5"]) {
      expect(isAllowedHost(h, {})).toBe(true);
    }
  });

  it("rejects foreign hosts when loopback-bound or unset", () => {
    expect(isAllowedHost("evil.example.com", {})).toBe(false);
    expect(isAllowedHost("evil.example.com:3002", { bindHost: "127.0.0.1" })).toBe(false);
    expect(isAllowedHost("192.168.1.20", { bindHost: "localhost", localNames: lan })).toBe(false);
  });

  it("allows a missing Host (non-browser, in-process callers)", () => {
    expect(isAllowedHost(undefined, {})).toBe(true);
  });

  it("on a wildcard bind allows machine names but not attacker names", () => {
    const policy = { bindHost: "0.0.0.0", localNames: lan };
    expect(isAllowedHost("192.168.1.20:3002", policy)).toBe(true);
    expect(isAllowedHost("MY-BOX.local:3002", policy)).toBe(true);
    expect(isAllowedHost("evil.example.com", policy)).toBe(false);
  });

  it("on a specific bind allows only that host", () => {
    const policy = { bindHost: "192.168.1.20", localNames: lan };
    expect(isAllowedHost("192.168.1.20:3002", policy)).toBe(true);
    expect(isAllowedHost("my-box", policy)).toBe(false);
  });

  it("always allows explicit PREVIEW_ALLOWED_HOSTS", () => {
    expect(isAllowedHost("studio.internal:3002", { allowedHosts: ["Studio.Internal"] })).toBe(true);
    expect(isAllowedHost("other.internal", { allowedHosts: ["studio.internal"] })).toBe(false);
  });

  it("reads the policy from env", () => {
    const policy = hostPolicyFromEnv({
      HYPERFRAMES_PREVIEW_HOST: "0.0.0.0",
      HYPERFRAMES_PREVIEW_ALLOWED_HOSTS: "a.test, b.test",
    });
    expect(policy.bindHost).toBe("0.0.0.0");
    expect(isAllowedHost("b.test", policy)).toBe(true);
  });
});

describe("createStudioApi host guard", () => {
  const adapter = {
    listProjects: () => [],
    resolveProject: () => null,
  } as unknown as StudioApiAdapter;

  it("403s foreign Host on GET, passes loopback", async () => {
    const api = createStudioApi(adapter);
    const bad = await api.request("http://x/projects", { headers: { host: "evil.example.com" } });
    expect(bad.status).toBe(403);
    const ok = await api.request("http://x/projects", { headers: { host: "localhost:3002" } });
    expect(ok.status).not.toBe(403);
  });
});
