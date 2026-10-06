import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioApi, isCrossOriginWrite } from "../createStudioApi";
import type { StudioApiAdapter } from "../types";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hf-project-root-"));
  tempDirs.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "index.html"), "<html></html>");
  const adapter: StudioApiAdapter = {
    listProjects: () => [],
    resolveProject: async (id) => ({ id, dir: project }),
    bundle: async () => null,
    lint: async () => ({ findings: [] }),
    runtimeUrl: "/api/runtime.js",
    rendersDir: () => join(root, "renders"),
    startRender: () => ({ id: "job", status: "rendering", progress: 0, outputPath: "out.mp4" }),
  };
  return { api: createStudioApi(adapter), project };
}

describe("project root protection", () => {
  it("refuses to delete the project root via a trailing-slash URL", async () => {
    const { api, project } = fixture();
    const res = await api.request("/projects/p/files/", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(existsSync(join(project, "index.html"))).toBe(true);
  });

  it("refuses to rename the project root", async () => {
    const { api, project } = fixture();
    const res = await api.request("/projects/p/files/", {
      method: "PATCH",
      body: JSON.stringify({ newPath: "moved" }),
    });
    expect(res.status).toBe(403);
    expect(existsSync(join(project, "index.html"))).toBe(true);
  });
});

describe("cross-origin write guard", () => {
  const host = "127.0.0.1:3002";

  it("rejects writes whose Origin differs from Host, or is malformed", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isCrossOriginWrite(method, "https://evil.example", host)).toBe(true);
      expect(isCrossOriginWrite(method, "null", host)).toBe(true);
    }
  });

  it("allows same-origin writes, requests without Origin, and reads", () => {
    expect(isCrossOriginWrite("PUT", `http://${host}`, host)).toBe(false);
    expect(isCrossOriginWrite("PUT", undefined, host)).toBe(false);
    expect(isCrossOriginWrite("GET", "https://evil.example", host)).toBe(false);
  });

  it("lets writes without an Origin header through the API", async () => {
    const { api } = fixture();
    const res = await api.request("/projects/p/files/b.txt", { method: "PUT", body: "x" });
    expect(res.status).not.toBe(403);
  });
});
