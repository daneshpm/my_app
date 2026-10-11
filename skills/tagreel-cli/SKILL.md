---
name: tagreel-cli
description: >
  Use the Tagreel CLI development loop: init, add, catalog, capture, lint, check, snapshot,
  compare, grade-compare, preview, play, present, beats, keyframes, single or batch render,
  cloudrun, feedback, lambda, doctor, browser, info, upgrade, skills, compositions, timeline, history, clean, docs,
  benchmark, telemetry, transcribe, tts, and remove-background. Also use when diagnosing build
  or render failures. validate, inspect, and layout are deprecated aliases; use check. Covers local,
  AWS Lambda, and Google Cloud Run rendering.
---

**Plugin installs:** Before setup or freshness commands, follow [plugin execution rules](../tagreel/references/plugin-installation.md) when this skill is inside a Tagreel plugin. Standalone installs keep the update instructions below.

# Tagreel CLI

Run commands as `npx tagreel ...` unless project instructions provide a wrapper. Obey the wrapper when present. The CLI requires Node.js 22 or newer and FFmpeg.

## Development loop

1. **Scaffold:** `npx tagreel init <project>` (centered blank). Or capture a site. Pass `--example=<name>` only to start from a named example.
2. **Find the move:** if the request names an asset, sound, image, voice or fast visual edit, resolve it through `/media-use` before proposing a plan. Otherwise, before authoring motion by hand, search for a primitive that already does it: `npx tagreel catalog --query "reveal a headline one line at a time"`. Ask for the effect you want rather than the mechanism you have in mind. Install with `npx tagreel add <name>` (see `/tagreel-registry`). Author by hand only once nothing fits.
3. **Author:** write the composition using `/tagreel-core`. To know what is on a project's timeline (tracks, clips, starts, ends, what plays), run `npx tagreel timeline --json` instead of reading `index.html` and every sub-composition file: nested rows carry absolute main-timeline `absStart`/`absEnd` and their owning `file`, not just their local, per-sub-composition time. Prefer `--json` over the text form; it costs fewer tokens for the same or better correctness. See `references/upgrade-info-misc.md` for one-liners that answer common questions without reading the whole output.
4. **Get fast feedback while editing:** run `npx tagreel lint` after the first HTML pass and after structural changes.
5. **Run the final gate:** run `npx tagreel check`; it reruns lint before opening the browser. Do not prepend a redundant standalone lint invocation. Add `--snapshots` for annotated overview frames and finding crops.
6. **Inspect sub-compositions:** when `index.html` mounts `data-composition-src`, capture midpoint snapshots and inspect each mounted scene.
7. **Open the final Studio preview:** run `npx tagreel preview --background`, verify the URL returns HTTP 200, hand the timeline project URL to the user, and ask whether to revise or render. Keep it alive until review ends.
8. **Render only after approval:** use `--quality draft` while iterating, `--quality looks` for the first real encode (the CLI default), and `--quality delivery` for final delivery.
9. **Verify the output:** confirm the file exists and is non-empty. Read the render summary's second line (`beginframe` vs `screenshot`, GPU, stage timings). `screenshot` + `software gpu` on Linux is the slow path. `ffprobe -v error -show_format -show_streams` and compare duration (and fps if the brief set it) to the root `data-duration`.

<!-- history (trial): remove this block together with the command -->

### Project history in your turn

Every write to the project is kept as an entry that can be undone. Use it at two moments only, never on every step:

- **Start of a turn:** `npx tagreel history begin --who <your-name> --label "<what you are about to do>"`, then `npx tagreel history --since mine --who <your-name>` to see what the person changed since your last turn. Build on their edits; never overwrite them.
- **A check failed, or the person says it got worse:** `npx tagreel history undo --who <your-name>` undoes your newest turn and leaves the person's edits alone. Do not hand-edit back. On a conflict it exits 2 and prints both choices.

End each turn with `npx tagreel history end`, so your writes read as yours, not as "Changed outside the app". While a turn is open, every write to the project counts as yours until 10 minutes pass without one; after that the turn has ended by itself.

<!-- /history (trial) -->

## Mandatory creator-edit cross-references

- Before authoring or diagnosing a zoom, punch-in/punch-out, reframe, camera
  move, or any keyframe motion, read `/tagreel-keyframes` first.
- Before `tagreel keyframes`, read `/tagreel-keyframes`; the command
  surfaces animation trajectories and does not diagnose clip cuts.
- For a cut, trim, splice, reorder, or source timing edit, read
  `/tagreel-core` and use its clip/timeline contract.
- For fade-in/fade-out, crossfade, track gain, volume automation, ducking,
  voiceover carve, or FX on placed audio, read `/tagreel-audio`. Load core
  alongside it when clip placement or picture timing also changes.
- A request naming an asset, sound, image, voice or fast visual edit resolves through `/media-use` before a plan is proposed.
  Copy creator edit markup from `/tagreel-core` → `references/creator-editing-recipes.md`.

```bash
# Fast iteration check; repeat while authoring as needed.
npx tagreel lint

# Required final gate; includes lint.
npx tagreel check
npx tagreel preview --background
npx tagreel render --quality looks --output out.mp4
test -s out.mp4
ffprobe -v error -show_format -show_streams out.mp4
```

`check` runs lint first, then uses one browser session and one seek pass to audit runtime errors, failed requests, layout, `*.motion.json` assertions, and WCAG contrast. Persistent findings gate the exit code; transient entrance or exit findings are informational. Use `--strict` to gate warnings. `validate`, `inspect`, and `layout` remain aliases for compatibility but must not appear in new instructions or scripts.

## Preview before render

Open the final composition preview (`#project/<name>`) only after `check` passes, to review the assembled timeline. The plan in chat and the `storyboard.html` sketch sheet are not approval of the final video. Rendering always requires the final approval defined by `tagreel/references/review-loop.md`.

## Sub-composition smoke test

Static audits cannot catch every mount failure. When the project uses sub-compositions, capture at least one visible midpoint for each host slot:

```bash
npx tagreel snapshot --at <t1>,<t2>,<t3>
```

Treat tiny unstyled content, canvas-sized icons, missing hero elements, or timeline-registration timeouts as render-blocking mount defects. See `tagreel-core/references/sub-compositions.md` for the corresponding fixes.

## Agent conventions

- **Search the catalog before writing motion by hand.** `npx tagreel catalog --query "<the beat, in plain English>"`. Search is entirely local: there is no hosted tier, no account, and the query text is never sent anywhere. By default it ranks on vocabulary shared with the item's name, title, description and tags, which misses any phrasing that does not reuse the catalog's own wording. Add `--on-device` to rank by meaning instead (see the offline tier below).
- **Query in English even when the video is not.** Both tiers index an English catalog, so a query in another script produces no searchable terms and returns nothing. Describe the move in English; the on-screen copy stays in whatever language the video needs. `No searchable words in query` means exactly this and is not a missing component, so do not report it as a catalog gap.
- **Read which tier answered; never infer it from results appearing.** With `--json` the envelope carries `query`, `tier` (`on-device` or `words`), `tier_detail`, `dropped`, `unindexed`, `shown`, `total` and `results`, plus `top_score` when the answering tier produces one and `warnings` when a tier was asked for and could not run, or when a search returned nothing and a better tier is still waiting on someone's consent. A weak result on `words` is expected; the same result on `on-device` is a bug. `top_score` is on-device only and has no threshold behind it: the ranker returns the whole catalog in some order for every query, so read it as evidence rather than as a pass or fail.
- **`dropped` and `unindexed` are opposite skews between the registry and the on-device index, and rewording the query fixes neither.** `dropped` counts ranked names this registry cannot install, so the strongest matches are the ones being lost. `unindexed` counts registry moves the index cannot see at all, which no query can ever return. Refreshing the registry is not the answer to either: its manifest carries a 24h TTL and heals itself, while the vectors are a separately published artifact fetched into `~/.tagreel/catalog/`. Re-running with `--on-device` refetches that index when `unindexed` is above zero, so that is the remedy to hand the user. A pure over-coverage skew (`dropped` above zero while `unindexed` is zero) does not trigger the refetch; clearing `~/.tagreel/catalog/` is the only way out of that one. Both counts are of names rather than of results, so either can exceed `total`.
- **Offer the offline tier; never enable it silently.** A one-time ~33 MB download (a quantized ONNX build of `bge-small-en-v1.5` plus its tokenizer, pinned to a fixed revision) and the catalog vectors from the registry, both cached under `~/.tagreel/`, neither added to the project or any package. Once cached it ranks by meaning with nothing sent. Say the size out loud and let the person decide, then pass `--on-device` (with `-y` to skip the prompt) once they agree. The interactive offer only fires on a TTY. Under `--json` there is no prompt, but a search that found nothing puts the same ask in `warnings`, so read that array and put the decision to the user yourself. When the person asks what the download is, why this model, or what leaves the machine, point them to https://github.com/daneshpm/my_app/tree/main/docs/developers/catalog-search.

- Prefer `--json` for agent and CI calls. Server-mode `render`, `preview`, and `play` do not provide ordinary JSON output; `preview --selection --json` and `preview --context --json` are query-mode exceptions.
- `doctor --json` always exits zero. Gate on its payload:

  ```bash
  npx tagreel doctor --json | jq -e '.ok' >/dev/null
  ```

- Non-TTY mode is automatic and scaffolds the centered blank. Pass `--example` only to start from a named example. Use `--non-interactive` to force flag-only mode on a TTY.
- Use one `TAGREEL_RUN_ID` for all commands in the same verification loop.
- When disk is tight, run `npx tagreel clean` (`--dry-run` to list first); it removes what dead renders left and idle caches that rebuild themselves, never outputs, sources or anything a running render uses. Write QC frames to a temp dir, not the project.
- Use `--strict`, `--strict-all`, and `--strict-variables` when the corresponding warnings, variables, or CI conditions must gate the render.
- JSON paths redact the home directory as `$HOME`; do not try to reverse the redaction.
- Never render merely because checks pass. Pause at the final preview and wait for approval.

## Studio-directed edits

When the user refers to “this element” or the current selection, query Studio instead of guessing:

```bash
npx tagreel preview --context --json --context-fields selection
```

Use `selection.target.hfId` when available, otherwise its selector and source file. If the result reports `no-selection`, ask the user to click the element and rerun. Request only the context slices you need; use `--context-detail full` only for computed styles or editable text metadata. Full behavior and failure codes live in `references/preview-render.md`.

## Render choices

| Need                                | Command                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Fast local iteration                | `npx tagreel render --quality draft`                                      |
| First real encode                   | `npx tagreel render --quality looks --output out.mp4`                     |
| Final local delivery                | `npx tagreel render --quality delivery --output out.mp4`                  |
| Reproducible container render       | `npx tagreel render --docker --strict --output out.mp4`                   |
| Local variable-driven batch render  | `npx tagreel render --batch rows.json --output "renders/{name}.mp4"`      |
| Self-managed distributed AWS render | `npx tagreel lambda render <project> --width 1920 --height 1080 --wait`   |
| Self-managed distributed GCP render | `npx tagreel cloudrun render <project> --width 1920 --height 1080 --wait` |

Skill attribution is automatic — the examples above need no `--skill`. A project scaffolded by a workflow (`tagreel init --skill=<workflow>`) records its owning skill in `tagreel.json`, and every later render inherits it on anonymous telemetry: re-renders, `npm run render`, and `--batch` alike. Pass `--skill=<slug>` explicitly only to stamp a project that was not created through a workflow (its first render then persists it).

Use Lambda only when AWS ownership is a requirement. Use Cloud Run only when GCP ownership is a requirement. Read the matching reference before running any cloud path.

## Read the matching reference before running a command

The following references and owning skills are mandatory command contracts, not optional background reading. Before running a command in the table, read its matching row.

| Need                                                                                               | Reference                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `init`, `capture`, `skills`                                                                        | `references/init-and-scaffold.md`     |
| `lint`, `check`, motion sidecars, `snapshot`                                                       | `references/lint-validate-inspect.md` |
| `compare`, `grade-compare`, variable-driven `render --batch`                                       | `references/compare-and-batch.md`     |
| `beats` for an existing project's Studio beat grid                                                 | `references/beats.md`                 |
| `preview`, `play`, `render`, Studio context, feedback                                              | `references/preview-render.md`        |
| `doctor`, browser management                                                                       | `references/doctor-browser.md`        |
| AWS Lambda deployment and rendering                                                                | `references/lambda.md`                |
| Google Cloud Run deployment and rendering                                                          | `references/cloudrun.md`              |
| `info`, `upgrade`, `compositions`, `timeline`, `docs`, `benchmark`, telemetry, media preprocessing | `references/upgrade-info-misc.md`     |

For composition variables, also read `/tagreel-core` → `references/variables-and-media.md`. For `tagreel add` and `tagreel catalog`, use `/tagreel-registry`. Before `tagreel present`, read `/slideshow`; before `tagreel keyframes`, read `/tagreel-keyframes`. For TTS, transcription, captions, or background removal choices, use `/media-use`.

The specialized commands are deliberately documented by their owning workflows:

```bash
npx tagreel present <project-dir> --port 3004 --no-open
npx tagreel beats <project-dir> --json
npx tagreel keyframes <project-dir> --json
npx tagreel media-treatment --capabilities
npx tagreel figma asset KEY:10-20
```

`present` serves a navigable deck with presenter and audience synchronization. `beats` is the standalone Studio beat-grid utility defined in `references/beats.md`. `keyframes` surfaces seek-safe animation and motion-path diagnostics. `media-treatment` discovers, applies, and clears deterministic looks on local footage — start with `--capabilities` for the overview and `--capability <name>` for one family; `/media-use` owns which treatment a brief is asking for. `figma` imports over the REST API with the `asset`, `tokens`, and `component` subcommands and needs `FIGMA_TOKEN`; motion and shader import have no REST endpoint and are agent-only, so `/figma` owns those.

## Commands you should not run

Two entries in `tagreel --help` are not part of the authoring loop, and reaching for them wastes a turn:

- `events` is the telemetry endpoint skills use to report their **own** invocation, ideally from a bundled script. It emits an anonymous event and exits 0 no matter what you pass it. It is not a way to read telemetry back, and an agent has no reason to call it by hand.
- `validate`, `inspect`, and `layout` are deprecated aliases kept for old scripts. `check` is the one that is maintained, and it is what every reference in this skill assumes.

## Remaining harness usage

Run `npx tagreel usage --json` at the start of a video workflow and again at milestones such as after drafting and before rendering. A fresh read at handoff can serve as the start read. Use `--harness claude-code`, `--harness codex`, or `--harness grok` to select explicitly.

Known results contain `status: "known"`, `harness`, `planTier`, `session`, and `weekly`. Each available window contains `usedPercent`, `remainingPercent`, and `resetsAt`; an unavailable window is `null`. `planTier` is the readable subscription tier when available, otherwise `null`. Claude Code reports its shared five-hour and weekly windows. Codex reports its shared session and weekly windows when available. Grok reports its included weekly allowance with `session: null`.

Unknown results contain `status: "unknown"` and a token-free `reason`. Missing, expired, unsupported, ambiguous, or unreadable logins and unavailable provider responses return unknown. Report the unknown state without guessing allowance. The command reads existing credentials without refreshing or rewriting them and emits no tokens or telemetry. Usage is a snapshot; it does not reserve allowance or estimate the next video's cost. Keep scope and workflow choices with the user.
