// @vitest-environment node
import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exceedsFreezeCap, freezeBytes, MAX_FREEZE_BYTES } from "./freeze";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "hf-freeze-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("exceedsFreezeCap", () => {
  it("is false at and under the cap, true just over it", () => {
    expect(exceedsFreezeCap(MAX_FREEZE_BYTES)).toBe(false);
    expect(exceedsFreezeCap(MAX_FREEZE_BYTES + 1)).toBe(true);
  });
});

describe("freezeBytes", () => {
  it("writes bytes to a nested path and returns the length", () => {
    const dest = join(scratch(), "images", "a.png");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(freezeBytes(bytes, dest)).toBe(4);
    expect(Array.from(readFileSync(dest))).toEqual([1, 2, 3, 4]);
  });

  it("throws on empty bytes", () => {
    expect(() => freezeBytes(new Uint8Array(0), join(scratch(), "x"))).toThrow();
  });
});

describe("freezeUrl allowlist", () => {
  it("accepts figma + figma-s3 hosts, https only", async () => {
    const { isAllowedFreezeUrl } = await import("./freeze");
    expect(isAllowedFreezeUrl("https://s3-alpha-sig.figma.com/img/x")).toBe(true);
    expect(isAllowedFreezeUrl("https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x")).toBe(
      true,
    );
    expect(isAllowedFreezeUrl("http://s3-alpha-sig.figma.com/img/x")).toBe(false);
    expect(isAllowedFreezeUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedFreezeUrl("https://evilfigma.com/x")).toBe(false);
    expect(isAllowedFreezeUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedFreezeUrl("not a url")).toBe(false);
  });

  it("refuses to freeze from a non-allowlisted url", async () => {
    const { freezeUrl } = await import("./freeze");
    await expect(freezeUrl("http://localhost:6379/x", "/tmp/never")).rejects.toThrow(
      /refusing non-figma url/,
    );
  });
});

describe("freezeUrl hardening", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only allows Figma's S3 buckets, not arbitrary amazonaws.com hosts", async () => {
    const { isAllowedFreezeUrl } = await import("./freeze");
    expect(isAllowedFreezeUrl("https://attacker-bucket.s3.amazonaws.com/x")).toBe(false);
    expect(isAllowedFreezeUrl("https://evil.s3.us-east-1.amazonaws.com/x")).toBe(false);
    expect(isAllowedFreezeUrl("https://sts.amazonaws.com/")).toBe(false);
    expect(isAllowedFreezeUrl("https://figma-alpha-api.s3.us-west-2.amazonaws.com/x")).toBe(true);
  });

  it("re-validates redirect hops and refuses a redirect to an internal host", async () => {
    const { freezeUrl } = await import("./freeze");
    const fetchMock = vi.fn(async (_url: string, init?: { redirect?: string }) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data/" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      freezeUrl("https://s3-alpha-sig.figma.com/img/x", join(scratch(), "a.png")),
    ).rejects.toThrow(/refusing non-figma url/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows an allowed redirect and writes the body", async () => {
    const { freezeUrl } = await import("./freeze");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://img.figma.com/b" } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 8, 7])));
    vi.stubGlobal("fetch", fetchMock);
    const dest = join(scratch(), "a.png");
    expect(await freezeUrl("https://s3-alpha-sig.figma.com/img/x", dest)).toBe(3);
    expect(Array.from(readFileSync(dest))).toEqual([9, 8, 7]);
  });

  it("aborts a body that exceeds the cap even without a content-length header", async () => {
    const { freezeUrl, MAX_FREEZE_BYTES: cap } = await import("./freeze");
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024 * 1024));
        if (pulled > cap * 4) controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(
      freezeUrl("https://s3-alpha-sig.figma.com/img/x", join(scratch(), "a.png")),
    ).rejects.toThrow(/exceeds/);
    expect(pulled).toBeLessThanOrEqual(cap + 2 * 64 * 1024 * 1024);
  });
});
