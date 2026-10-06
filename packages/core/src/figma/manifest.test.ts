// @vitest-environment node
import { describe, expect, it, afterEach } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRecord,
  findByFigmaNode,
  manifestPath,
  nextId,
  readManifest,
  updateRecord,
} from "./manifest";
import type { FigmaManifestRecord } from "./types";

const dirs: string[] = [];
function project(): string {
  const d = mkdtempSync(join(tmpdir(), "hf-manifest-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rec(id: string, nodeId: string): FigmaManifestRecord {
  return {
    id,
    type: "image",
    path: `.media/images/${id}.png`,
    source: "figma",
    provenance: { source: "figma", fileKey: "FK", nodeId, format: "png" },
  };
}

describe("manifest", () => {
  it("appends and reads back records", () => {
    const p = project();
    appendRecord(p, rec("image_001", "1:2"));
    appendRecord(p, rec("image_002", "3:4"));
    const all = readManifest(p);
    expect(all.map((r) => r.id)).toEqual(["image_001", "image_002"]);
    expect(all[1]?.provenance.nodeId).toBe("3:4");
  });

  it("finds a record by figma node", () => {
    const p = project();
    appendRecord(p, rec("image_001", "1:2"));
    expect(findByFigmaNode(p, "FK", "1:2")?.id).toBe("image_001");
    expect(findByFigmaNode(p, "FK", "9:9")).toBeNull();
  });

  it("allocates incrementing ids per type", () => {
    const p = project();
    expect(nextId(p, "image")).toBe("image_001");
    appendRecord(p, rec("image_001", "1:2"));
    expect(nextId(p, "image")).toBe("image_002");
  });

  it("skips a manifest line that doesn't match the record shape", () => {
    const p = project();
    appendRecord(p, rec("image_001", "1:2"));
    appendFileSync(manifestPath(p), JSON.stringify({ foo: "bar" }) + "\n");
    appendRecord(p, rec("image_002", "3:4"));
    expect(readManifest(p).map((r) => r.id)).toEqual(["image_001", "image_002"]);
  });

  it("nextId scans other writers' rows (media-use) so ids never collide", () => {
    const p = project();
    mkdirSync(join(p, ".media"), { recursive: true });
    // media-use shaped row: no provenance.source — fails the figma guard
    appendFileSync(
      manifestPath(p),
      JSON.stringify({
        id: "image_007",
        type: "image",
        path: ".media/images/image_007.png",
        source: "unsplash",
        provenance: { provider: "unsplash" },
      }) + "\n",
    );
    expect(nextId(p, "image")).toBe("image_008");
  });

  it("rejects manifest rows with a non image/video type", () => {
    const p = project();
    mkdirSync(join(p, ".media"), { recursive: true });
    appendFileSync(
      manifestPath(p),
      JSON.stringify({
        id: "audio_001",
        type: "audio",
        path: "x",
        source: "figma:F/1",
        provenance: { source: "figma", fileKey: "F", nodeId: "1:1" },
      }) + "\n",
    );
    expect(readManifest(p)).toHaveLength(0);
  });
});

describe("manifest atomic rewrite", () => {
  it("updateRecord rewrites one row and leaves no temp files behind", () => {
    const p = project();
    appendRecord(p, rec("image_001", "1:2"));
    appendRecord(p, rec("image_002", "3:4"));
    updateRecord(p, { ...rec("image_002", "3:4"), path: ".media/images/new.png" });
    expect(readManifest(p).map((r) => r.path)).toEqual([
      ".media/images/image_001.png",
      ".media/images/new.png",
    ]);
    expect(readdirSync(join(p, ".media")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("manifest concurrency", () => {
  it("nextId reserves ids so back-to-back mints never collide", () => {
    const p = project();
    const a = nextId(p, "image");
    const b = nextId(p, "image");
    expect(a).not.toBe(b);
    appendRecord(p, rec(a, "1:1"));
    appendRecord(p, rec(b, "2:2"));
    expect(readManifest(p).map((r) => r.id)).toEqual([a, b]);
    expect(readdirSync(join(p, ".media", ".reserved-ids"))).toEqual([]);
  });

  it("takes over a stale lock left by a dead process", () => {
    const p = project();
    mkdirSync(join(p, ".media"), { recursive: true });
    const lock = join(p, ".media", "manifest.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(nextId(p, "image")).toBe("image_001");
  });

  it("waits for a lock held by another process, then proceeds", async () => {
    const p = project();
    mkdirSync(join(p, ".media"), { recursive: true });
    const lock = join(p, ".media", "manifest.lock");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");fs.closeSync(fs.openSync(${JSON.stringify(lock)},"wx"));` +
          `console.log("held");setTimeout(()=>{fs.rmSync(${JSON.stringify(lock)});},400);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    const t0 = Date.now();
    const id = nextId(p, "image");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(id).toBe("image_001");
    await new Promise((resolve) => holder.once("exit", resolve));
  });
});
