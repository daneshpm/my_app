import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("telemetry is removed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("never makes a network request or spawns a sender when events are emitted", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);

    const client = await import("./client.js");
    const events = await import("./events.js");

    expect(client.shouldTrack()).toBe(false);

    client.trackEvent("cli_command", { command: "render" });
    events.trackCommand("render", "run-id");
    events.trackCliError({ error_name: "Error", error_message: "boom", kind: "command_error" });
    await client.flush();
    client.flushSync();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
