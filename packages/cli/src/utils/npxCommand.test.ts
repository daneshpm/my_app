import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildNpmCommand, buildNpxCommand, buildShimCommand } from "./npxCommand.js";

describe("buildNpxCommand", () => {
  it.each([
    ["linux", "npx", ["--version"]],
    ["darwin", "npx", ["--version"]],
    ["win32", "cmd.exe", ["/d", "/s", "/c", "npx.cmd", "--version"]],
  ] as const)("builds the %s npx invocation", (platform, expectedCommand, expectedArgs) => {
    expect(buildNpxCommand(["--version"], platform)).toEqual({
      command: expectedCommand,
      args: expectedArgs,
    });
  });

  // Real npx cold-start on Windows CI routinely exceeds vitest's 5s default,
  // making this smoke test flaky. Give it generous headroom (it still asserts
  // a real version string, so it isn't reduced to a tautology by mocking).
  it("executes the host npx version check through the resolved command", () => {
    const npx = buildNpxCommand(["--version"]);
    const version = execFileSync(npx.command, npx.args, {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);
});

describe("buildNpmCommand", () => {
  it.each([
    ["linux", "npm", ["--version"]],
    ["darwin", "npm", ["--version"]],
    ["win32", "cmd.exe", ["/d", "/s", "/c", "npm.cmd", "--version"]],
  ] as const)("builds the %s npm invocation", (platform, expectedCommand, expectedArgs) => {
    expect(buildNpmCommand(["--version"], platform)).toEqual({
      command: expectedCommand,
      args: expectedArgs,
    });
  });
});

describe("buildShimCommand", () => {
  it("passes through on posix", () => {
    expect(buildShimCommand("gcloud", ["a", "b&c"], "linux")).toEqual({
      command: "gcloud",
      args: ["a", "b&c"],
    });
  });
  it("routes through cmd.exe on win32 and quotes metacharacters", () => {
    expect(buildShimCommand("gcloud", ["services", "p&calc"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "gcloud.cmd", "services", '"p&calc"'],
    });
  });
  it("rejects double quotes on win32", () => {
    expect(() => buildShimCommand("sam", ['a"b'], "win32")).toThrow();
  });
});
