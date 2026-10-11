// sfx.mjs — sound effects for the media audio engine. Cues are resolved against
// the bundled library (assets/sfx/manifest.json), copying matched files into the
// project. Offline, deterministic, free.
//
// A cue that matches nothing is skipped (recorded as an anomaly); SFX never
// blocks a render. Every cue sits at volume ~0.35, under voice + BGM.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestRecordFor } from "../../../scripts/lib/manifest.mjs";
import { agentWritePath } from "./media-record.mjs";

const SFX_VOLUME = 0.35;
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
const r3 = (x) => Number(x.toFixed(3));

// cues: [{ id, name }] (id = the line/frame/scene the cue fires in). Returns
// { sfx: [{ id, name, file, source, offset_s, duration_s, volume }], anomalies }.
export async function resolveSfx({ cues, tagreelDir, sfxLibDir }) {
  const sfx = [];
  const anomalies = [];
  const destDir = join(tagreelDir, "assets", "sfx");
  // Each effect's file this run: one effect named twice gets one file, and two effects never share one.
  const fileFor = new Map();

  // Dedupe identical (id,name) cues — the same effect named twice in one line
  // downloads/copies once.
  const seen = new Set();
  const uniq = cues.filter((c) => {
    const k = `${c.id}:${c.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // ── bundled library ──
  const manifestPath = join(sfxLibDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    if (uniq.length) anomalies.push(`no SFX library at ${sfxLibDir} — all cues dropped`);
    return { sfx, anomalies };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    anomalies.push(`SFX manifest parse failed (${e.message}) — all cues dropped`);
    return { sfx, anomalies };
  }
  // Build lookups: by manifest key, by file basename, and by slug of either, so
  // a cue can name "whoosh", "whoosh.mp3", or "ui click" (→ slug match).
  const byKey = new Map();
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry?.file || !isFinite(entry.duration)) continue;
    const rec = { key, file: entry.file, duration: entry.duration };
    byKey.set(key, rec);
    byKey.set(entry.file, rec);
    byKey.set(slug(key), rec);
    byKey.set(slug(entry.file.replace(/\.\w+$/, "")), rec);
  }
  mkdirSync(destDir, { recursive: true });
  for (const { id, name } of uniq) {
    const hit = byKey.get(name) ?? byKey.get(slug(name));
    if (!hit) {
      const known = [...new Set([...byKey.values()].map((v) => v.key))].slice(0, 8).join(", ");
      anomalies.push(
        `sfx "${name}" (id ${id}): not in bundled library — skipped (have: ${known}…)`,
      );
      continue;
    }
    const src = join(sfxLibDir, hit.file);
    const library = existsSync(src) ? readFileSync(src) : null;
    const isLibraryCopy = (rel) =>
      library &&
      existsSync(join(tagreelDir, rel)) &&
      readFileSync(join(tagreelDir, rel)).equals(library);
    const destRel =
      fileFor.get(hit.file) ??
      agentWritePath(tagreelDir, `assets/sfx/${hit.file}`, {
        anomalies,
        taken: new Set(fileFor.values()),
        // An unrecorded copy of the library file is one an engine run made before the manifest had it.
        reusable: (rel) => !latestRecordFor(tagreelDir, rel) && isLibraryCopy(rel),
      });
    const dest = join(tagreelDir, destRel);
    // The bundled library may be incomplete: some installs of the skill ship
    // manifest.json without the actual mp3s. Pushing an sfx entry that points at
    // a file we never copied produces a dangling reference that silently drops
    // downstream ("not on disk"). Surface it as a loud anomaly and skip the cue
    // instead, so the audio_meta never references a missing file.
    if (library) {
      if (!isLibraryCopy(destRel)) copyFileSync(src, dest);
    } else if (!existsSync(dest)) {
      anomalies.push(
        `sfx "${name}" (id ${id}): bundled file ${hit.file} missing from the offline ` +
          `library (${sfxLibDir}) — skipped. Reinstall the media-use skill to ` +
          `restore assets/sfx/*.mp3.`,
      );
      continue;
    } // else the engine's earlier copy at dest stands in for the file this install lacks
    fileFor.set(hit.file, destRel);
    sfx.push({
      id,
      name,
      file: destRel,
      source: "local",
      offset_s: 0,
      duration_s: r3(hit.duration),
      volume: SFX_VOLUME,
    });
  }
  return { sfx, anomalies };
}
