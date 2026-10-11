# Ownership matrix, usage stats, telemetry, privacy

Maintainer-facing reference. Nothing here changes how you resolve or operate on media.

## What it owns (the gaps Tagreel leaves)

Tagreel owns media _playback_; media-use owns everything else. Each row is enforced by `scripts/lib/coverage.test.mjs` so the claim can't rot.

| Tagreel gap                                | media-use owns it via                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio-only, no image/icon                  | `resolve --type image` (local mflux / codex generation); icons via `--from`                                                                                                      |
| No third-party brand logos                 | `resolve --type logo` (theSVG → GitHub org avatar → domain favicon)                                                                                                              |
| No voice / audio generation                | `resolve --type voice` (local Kokoro) + the audio engine (`audio/scripts/audio.mjs`)                                                                                             |
| Scattered/duplicated audio engine          | one consolidated engine under `audio/` (tagreel-media retired)                                                                                                                   |
| No agent media-ops (cut/reframe/transform) | `references/operations.md` + `resolve --from` to register outputs                                                                                                                |
| No transcript-driven cutting               | `scripts/transcript-cut.mjs` compiles word-timestamp edits into cut lists                                                                                                        |
| No auto-duck / publish loudness            | `scripts/audio-duck.mjs` + `references/operations.md` loudnorm/sidechain recipes                                                                                                 |
| No cross-project memory                    | global content-addressed cache + auto-promote (`~/.media`)                                                                                                                       |
| Grade recipes and LUT freezing             | `resolve --type grade` emits a paste-ready recipe and `resolve --type lut` freezes validated `.cube` files; direct element analysis/authoring lives in `tagreel media-treatment` |
| No image generation                        | RAM-graded local mflux (FLUX) via `scripts/lib/mflux-provider.mjs`, codex `image_gen` upsell (`scripts/lib/codex-provider.mjs`)                                                  |
| No video generation                        | `resolve --type video` — local LTX (`videogen` in `scripts/lib/local-models.mjs`)                                                                                                |
| Weak local-model defaults                  | local open-source tools (`scripts/lib/local-run.mjs`)                                                                                                                            |

## Usage stats

Use `resolve --stats` for a local, shareable report over the current project's `.media/` manifest, the global `~/.media/` cache, and local resolve misses. Human output is compact; add `--json` for a single machine-readable object, and `--days N` to window timestamped records.

```bash
npx tagreel media-use resolve --stats --project . --days 7
# media-use stats
# total resolves: 12
# misses: 2
# hit rate: 86%
```

## Telemetry

None. This fork sends no usage data: `scripts/lib/telemetry.mjs` exports a no-op `track`.

## Privacy

media-use sends nothing anywhere: no usage events, no install id, no account linkage.
