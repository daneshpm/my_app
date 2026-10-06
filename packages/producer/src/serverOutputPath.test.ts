import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRenderBody } from "./server";

describe("prepareRenderBody outputPath containment", () => {
  const rendersDir = join(tmpdir(), "hf-renders-test");

  it("rejects an outputPath outside the renders dir before creating anything", async () => {
    const result = await prepareRenderBody(
      { html: "<html></html>", outputPath: join(tmpdir(), "elsewhere", "x.mp4") },
      rendersDir,
    );
    expect("error" in result).toBe(true);
  });

  it("rejects a traversal that escapes the renders dir", async () => {
    const result = await prepareRenderBody(
      { html: "<html></html>", outputPath: join(rendersDir, "..", "x.mp4") },
      rendersDir,
    );
    expect("error" in result).toBe(true);
  });

  it("accepts an outputPath inside the renders dir", async () => {
    const result = await prepareRenderBody(
      { html: "<html></html>", outputPath: join(rendersDir, "ok.mp4") },
      rendersDir,
    );
    expect("error" in result).toBe(false);
    if (!("error" in result) && result.prepared.cleanupProjectDir) {
      rmSync(result.prepared.cleanupProjectDir, { recursive: true, force: true });
    }
  });
});
