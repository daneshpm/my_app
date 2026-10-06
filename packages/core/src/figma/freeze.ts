/**
 * "Freeze" = write asset bytes to local disk permanently so renders never
 * re-fetch from figma (design spec §5) — not Object.freeze.
 */

import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ponytail: bound the write so a hostile/runaway source can't fill the disk.
export const MAX_FREEZE_BYTES = 256 * 1024 * 1024;

export function exceedsFreezeCap(byteLength: number): boolean {
  return byteLength > MAX_FREEZE_BYTES;
}

export function freezeBytes(bytes: Uint8Array, destPath: string): number {
  if (bytes.length === 0) throw new Error("freeze failed: empty bytes");
  if (exceedsFreezeCap(bytes.length))
    throw new Error(`freeze failed: ${bytes.length} bytes exceeds ${MAX_FREEZE_BYTES} cap`);
  mkdirSync(dirname(destPath), { recursive: true });
  // Exclusive create; on EEXIST remove and retry — never write through an
  // existing file or planted symlink (CodeQL js/insecure-temporary-file).
  try {
    writeFileSync(destPath, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    rmSync(destPath);
    writeFileSync(destPath, bytes, { flag: "wx" });
  }
  return bytes.length;
}

/**
 * Buckets Figma serves image/asset renders from. Any other `*.amazonaws.com`
 * host (an attacker-controlled bucket) is refused.
 */
const FIGMA_S3_BUCKETS = new Set(["figma-alpha-api", "figma-alpha"]);
const S3_BUCKET_HOST_RE = /^([a-z0-9-]+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const MAX_FREEZE_REDIRECTS = 3;

/**
 * Only figma-owned hosts may be frozen from a URL — render/CDN responses
 * come from figma.com subdomains or figma's S3 buckets. Blocks SSRF via a
 * crafted manifest/config URL (metadata endpoints, internal services).
 */
export function isAllowedFreezeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "figma.com" || host.endsWith(".figma.com")) return true;
  const bucket = S3_BUCKET_HOST_RE.exec(host)?.[1];
  return bucket !== undefined && FIGMA_S3_BUCKETS.has(bucket);
}

/** Read a response body, aborting as soon as the byte cap is crossed. */
async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (exceedsFreezeCap(total)) {
      await reader.cancel();
      throw new Error(`freeze failed: body exceeds ${MAX_FREEZE_BYTES} cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function freezeUrl(url: string, destPath: string): Promise<number> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    if (!isAllowedFreezeUrl(current))
      throw new Error(
        `freeze failed: refusing non-figma url ${current} (https + figma hosts only)`,
      );
    const res = await fetch(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop >= MAX_FREEZE_REDIRECTS)
        throw new Error("freeze failed: too many or invalid redirects");
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`freeze failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (exceedsFreezeCap(declared))
      throw new Error(`freeze failed: content-length ${declared} exceeds ${MAX_FREEZE_BYTES} cap`);
    return freezeBytes(await readCapped(res), destPath);
  }
}

export function freezeLocalFile(srcPath: string, destPath: string): void {
  const size = statSync(srcPath).size;
  if (exceedsFreezeCap(size))
    throw new Error(`freeze failed: ${size} bytes exceeds ${MAX_FREEZE_BYTES} cap`);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}
