import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { replaceFileAtomically } from "../atomicFile";
import { readJsonlValues } from "./jsonl";
import type { FigmaManifestRecord } from "./types";

const MANIFEST_FILE = "manifest.jsonl";
const LOCK_FILE = "manifest.lock";
const RESERVE_DIR = ".reserved-ids";
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 20_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lock next to the manifest (exclusive-create lock file with
 * backoff). A lock older than LOCK_STALE_MS belongs to a dead process and is
 * taken over. Not re-entrant — never nest calls.
 */
function withManifestLock<T>(projectDir: string, task: () => T): T {
  mkdirSync(mediaDir(projectDir), { recursive: true });
  const lockPath = join(mediaDir(projectDir), LOCK_FILE);
  const started = Date.now();
  let delay = 5;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      break;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST")
        throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS)
        throw new Error(`figma manifest is locked by another process; delete ${lockPath}`);
      sleepSync(delay);
      delay = Math.min(delay * 2, 100);
    }
  }
  try {
    return task();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

// Mirrors the media-use `.media/` layout for interop (one shared inventory).
const TYPE_DIRS: Record<FigmaManifestRecord["type"], string> = {
  image: "images",
  video: "video",
};

export function mediaDir(projectDir: string): string {
  return join(projectDir, ".media");
}

export function manifestPath(projectDir: string): string {
  return join(mediaDir(projectDir), MANIFEST_FILE);
}

export function typeDirPath(projectDir: string, type: FigmaManifestRecord["type"]): string {
  return join(mediaDir(projectDir), TYPE_DIRS[type]);
}

/**
 * Guards figma-OWNED rows only — media-use rows (bgm/sfx/icon, no
 * provenance.source) legitimately fail this and are filtered out of
 * figma's read-view. The shared file is the inventory; each writer
 * reads its own rows. `nextId` is the one cross-writer concern and
 * scans the full file.
 */
export function isFigmaManifestRecord(value: unknown): value is FigmaManifestRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || !("type" in value) || !("path" in value) || !("source" in value))
    return false;
  if (
    typeof value.id !== "string" ||
    (value.type !== "image" && value.type !== "video") ||
    typeof value.path !== "string"
  )
    return false;
  if (typeof value.source !== "string") return false;
  if (!("provenance" in value)) return false;

  const provenance = value.provenance;
  if (typeof provenance !== "object" || provenance === null) return false;
  if (!("source" in provenance) || !("fileKey" in provenance) || !("nodeId" in provenance))
    return false;
  return (
    provenance.source === "figma" &&
    typeof provenance.fileKey === "string" &&
    typeof provenance.nodeId === "string"
  );
}

export function readManifest(projectDir: string): FigmaManifestRecord[] {
  return readJsonlValues(manifestPath(projectDir)).filter(isFigmaManifestRecord);
}

export function appendRecord(projectDir: string, record: FigmaManifestRecord): void {
  mkdirSync(typeDirPath(projectDir, record.type), { recursive: true });
  withManifestLock(projectDir, () => {
    appendFileSync(manifestPath(projectDir), JSON.stringify(record) + "\n");
    // The row now carries the id; drop the reservation `nextId` left for it.
    rmSync(join(mediaDir(projectDir), RESERVE_DIR, record.id), { force: true });
  });
}

export function findByFigmaNode(
  projectDir: string,
  fileKey: string,
  nodeId: string,
): FigmaManifestRecord | null {
  return findAllByFigmaNode(projectDir, fileKey, nodeId)[0] ?? null;
}

/** EVERY row for a node — reuse gates must check all (format, scale, version)
 * tuples, not just the oldest, or a second tuple defeats idempotency forever. */
export function findAllByFigmaNode(
  projectDir: string,
  fileKey: string,
  nodeId: string,
): FigmaManifestRecord[] {
  return readManifest(projectDir).filter(
    (r) =>
      r.provenance.source === "figma" &&
      r.provenance.fileKey === fileKey &&
      r.provenance.nodeId === nodeId,
  );
}

/** Rewrite one row in place by id, preserving every other line (other
 * writers' rows included) byte-for-byte. */
export function updateRecord(projectDir: string, record: FigmaManifestRecord): void {
  withManifestLock(projectDir, () => updateRecordLocked(projectDir, record));
}

function updateRecordLocked(projectDir: string, record: FigmaManifestRecord): void {
  const p = manifestPath(projectDir);
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return line;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isFigmaManifestRecord(parsed) && parsed.id === record.id) return JSON.stringify(record);
    } catch {
      // non-JSON line — preserve untouched
    }
    return line;
  });
  replaceFileAtomically(p, out.join("\n"));
}

/**
 * Mints the next free id AND reserves it (a marker file under the lock), so a
 * concurrent writer between this call and `appendRecord` cannot mint the same
 * id. `appendRecord` clears the reservation; an id minted but never appended
 * is simply skipped (a gap, never a duplicate).
 */
export function nextId(projectDir: string, type: FigmaManifestRecord["type"]): string {
  return withManifestLock(projectDir, () => {
    const id = nextIdUnlocked(projectDir, type);
    const dir = join(mediaDir(projectDir), RESERVE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id), "");
    return id;
  });
}

function nextIdUnlocked(projectDir: string, type: FigmaManifestRecord["type"]): string {
  const re = new RegExp(`^${type}_(\\d+)$`);
  let max = 0;
  // Scan EVERY writer's rows (media-use included), not just figma-owned ones —
  // ids and file paths are shared across the inventory, so a figma id minted
  // from a figma-only view would collide with media-use's image_NNN files.
  const p = manifestPath(projectDir);
  const reserveDir = join(mediaDir(projectDir), RESERVE_DIR);
  if (existsSync(reserveDir)) {
    for (const name of readdirSync(reserveDir)) {
      const n = name.match(re)?.[1];
      if (n !== undefined) max = Math.max(max, Number.parseInt(n, 10));
    }
  }
  if (!existsSync(p)) return `${type}_${String(max + 1).padStart(3, "0")}`;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      typeof parsed.id !== "string"
    )
      continue;
    const m = parsed.id.match(re);
    const n = m?.[1];
    if (n !== undefined) max = Math.max(max, Number.parseInt(n, 10));
  }
  return `${type}_${String(max + 1).padStart(3, "0")}`;
}
