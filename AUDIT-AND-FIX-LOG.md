# Hyperframes — Audit & Fix Log

Date: 2026-10-06 · Branch: `main` · Nothing in this log has been committed.

> ## Update (second pass) — read this first
>
> After the first version of this log, the following was done on branch `rebrand-and-hardening`:
>
> - **Baselined the red tests against clean code.** The 2 `ffBinaries`, `assetResolution`, 2 `htmlBundler` symlink, `hyperframeRuntimeLoader`, `renderDirOwner`, `segmentManifest`, `captureHdrResources` and one `ffprobeArgvContract` failures also fail without our changes (Windows / runner-lane quirks). The producer `htmlCompiler.parity`, `mediaProbeConcurrency`, `renderCommitCancellation` files pass with and without our changes under vitest. **No regressions from our changes were found, but the full suite was still never run to completion in one go.**
> - **Fixed the remaining gaps:** DNS-rebinding Host allowlist (`studio-server/src/helpers/hostAllowlist.ts`, env `HYPERFRAMES_PREVIEW_ALLOWED_HOSTS`), optional producer bearer auth (`PRODUCER_AUTH_TOKEN`), producer `entryFile` containment + `PRODUCER_RESTRICT_EXTERNAL_ASSETS`, production job-TTL cleanup, Figma `nextId` lock + reservation markers, shutdown / `/outputs` / shader-dispose tests, dead `audioExtractor.ts` removed, dependency ranges aligned (same major), `bun.lock` refreshed.
> - **Rebrand to `my_app`:** studio header logo + favicon, docs logos, app icons, README, docs prose, plugin manifests, CLI banner/help strings. Package names, the `hyperframes` CLI command, env vars, functional URLs, `LICENSE` and upstream attribution were intentionally kept. The README still carries upstream Discord links / screenshots, and some `docs/images` screenshots may show the old logo.
> - **Final `bun run build`: exit 0.** The build regenerates ~170 files under `docs/catalog`, `docs/public/catalog*`, `registry/registry.json` and `registry/catalog-artifact`; these were **deliberately not committed**. `docs/docs.json` was committed with the rebrand fields only (committed navigation kept).
> - **Final test comparison (same failing files, with changes vs clean `HEAD`, run in isolation):** 54 vs 53 failures. The extra one was `cli init > bare init scaffolds the centered blank`, caused by a pre-existing **uncommitted edit to `packages/cli/src/templates/blank/index.html`** (it adds `window.__timelines = ...` which an upstream test forbids) — that file is deliberately **not** in the commit. A studio `hexRatchet` failure caused by a hex colour in the new logo was fixed. The studio package's other failure (`PropertyPanel`) only fails under load. A whole-suite run under load shows many extra timeouts/flakes (engine, cli, studio-server, core), so isolated comparison is the reliable signal.
> - Still open: maps still load gsap/d3/topojson from jsDelivr (repo convention for gsap; no sanctioned vendoring for d3/topojson); the browser gate (`hyperframes check`) and a real render were not run; the 18 Windows-only studio-server failures are not baselined individually; `sdk-playground` version left at 0.6.106.
>
> The sections below are the **first-pass** log; where they conflict with this update, this update wins.

This file records (1) what the application is, (2) the code audit that was run, (3) every fix made, (4) how each was verified, and (5) what is still open or still needs to be created. It is deliberately honest about what is **not** verified.

---

## 1. What is in the application

Hyperframes is an open-source framework: **write HTML, render video.** Compositions are HTML files using `data-*` timing attributes and one paused GSAP timeline on `window.__timelines`.

| Area               | Path                                            | Role                                                                            |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| CLI                | `packages/cli`                                  | `create`, `preview`, `lint`, `check`, `render`, `publish`, `lambda`, `cloudrun` |
| Core               | `packages/core`                                 | Types, compiler, runtime, frame adapters, Figma import, beats                   |
| Engine             | `packages/engine`                               | Seekable capture engine (Puppeteer + FFmpeg), audio mixer, frame extractor      |
| Producer           | `packages/producer`                             | Full render pipeline + HTTP render server                                       |
| Studio             | `packages/studio`                               | Browser composition editor UI                                                   |
| Studio server      | `packages/studio-server`                        | HTTP API behind `hyperframes preview` (files, render, thumbnails…)              |
| Player             | `packages/player`                               | Embeddable `<hyperframes-player>` web component                                 |
| Shader transitions | `packages/shader-transitions`                   | WebGL transitions                                                               |
| Parsers / Lint     | `packages/parsers`, `packages/lint`             | HTML/GSAP parsing, static linter                                                |
| Cloud targets      | `packages/aws-lambda`, `packages/gcp-cloud-run` | Cloud rendering                                                                 |
| SDK                | `packages/sdk`, `packages/sdk-playground`       | Programmatic API + playground                                                   |
| Registry           | `registry/`                                     | ~400 installable blocks, components, examples                                   |
| Skills             | `skills/`                                       | 21 AI agent skills (`/hyperframes` is the entry point)                          |
| Docs               | `docs/`                                         | Mintlify site                                                                   |

Tooling: **bun** (not pnpm/npm), **oxlint** + **oxfmt**, conventional commits. Local environment: Windows 11, Bun 1.4.2 at `C:\Users\pavan\.bun\bin` (not on the default shell PATH — prepend it).

---

## 2. The audit

Four read-only audits ran in parallel (core · engine+producer · cli+studio+player+shaders · repo health). All findings came from reading code; **none were reproduced at runtime**. Items that held up were fixed (section 3); the rest are in section 5.

Areas that looked healthy: command injection (every spawn uses argv arrays), path containment in `fileServer.ts` and studio uploads, the player package, registry manifests, skill-catalog sync (21 skills on every surface), scaffolded template files being byte-identical.

---

## 3. Fixes made

### Critical

| #   | Problem                                                                                | Fix                                                                                                                     | File(s)                                                                          |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `DELETE /projects/:id/files/` (empty path) deleted the **whole project** incl. backups | Delete and rename now return 403 when the target is the project root                                                    | `studio-server/src/routes/files.ts`                                              |
| 2   | Studio API accepted cross-site writes (CSRF)                                           | `isCrossOriginWrite` middleware: writes with an `Origin` that ≠ `Host` get 403; no-Origin clients (CLI/curl) unaffected | `studio-server/src/createStudioApi.ts`                                           |
| 3   | Producer server listened on all interfaces, no auth                                    | Binds `127.0.0.1` by default; override with `PRODUCER_HOST` / `hostname`                                                | `producer/src/server.ts`                                                         |
| 4   | Arbitrary file overwrite via `outputPath` (ffmpeg `-y`)                                | HTTP renders reject `outputPath` outside the renders dir (400); default renders dir is `os.tmpdir()`                    | `producer/src/server.ts`                                                         |
| 5   | Bad `workers` value leaked a render slot → server wedged                               | Job built inside `try/finally` (also in `renderStream`)                                                                 | `producer/src/server.ts`                                                         |
| 6   | Media `id` path traversal (`<video id="../..">` could trigger recursive delete)        | New `safeIdSegment`; safe ids keep their exact paths, others get sanitized + hash                                       | `engine/src/utils/safePathSegment.ts`, `audioMixer.ts`, `videoFrameExtractor.ts` |

### Major

- **SSRF:** `previewUrl` and `<script src>` inlining now use the guarded HTTPS-only downloader (public hosts, redirect re-validation, size/time caps). Figma `freezeUrl` now uses an exact S3-bucket allowlist, manual redirects (≤3 hops, each re-checked) and a streaming byte cap.
- **ffmpeg hardening:** `-protocol_whitelist file,pipe,crypto,data` on local inputs and all ffprobe calls; `#EXTM3U` / `ffconcat` payloads rejected.
- **Producer server:** per-render `AbortController`, shutdown aborts renders + kills tracked processes + cleans temp dirs; body-size limit (`PRODUCER_MAX_BODY_BYTES`, default 64 MiB → 413); `PRODUCER_MAX_CONCURRENT_RENDERS` validated; keep-alive timeouts set; optional `PRODUCER_RENDER_TIMEOUT_MS`; client disconnect cancels the render; `Semaphore.acquire(signal)` + idempotent release; `/outputs/:token` derives content-type and handles stream errors; browser-close calls bounded with timeouts; ffprobe JSON stdout capped (8 MiB).
- **Studio / CLI:** render delete/view/download fixed for Windows paths; render job ids no longer collide within a second; real HTTP Range (206/416) with streaming instead of whole-file reads; a successful render no longer flips to "failed" if the meta file write throws; dev-server request body capped (413); upload filter no longer rejects names like `a..b.mp4`; thumbnail cache filenames are Windows-safe (cache version bumped v5→v6); `gcloud`/`sam` now work on Windows via a `.cmd` shim builder.
- **Core correctness:** caption overrides now gate render-ready (was a race); WAAPI adapter no longer drops finished animations; Three.js adapter no longer hangs if user code replaces `onLoad`; Figma importer key matching (`y:` vs `opacity:`) and malformed-literal handling; `timingCompiler` / `beatFile` regexes no longer match `<video-player>`, `<divider>`, `data-src`, etc.; quote-aware tag scanning; default composition id is a content hash (was `Date.now()`); vendor-prefixed `@keyframes` treated as global; `$` patterns in inlined CSS no longer corrupted; non-OK beat-audio responses throw clearly; Figma manifest/bindings written atomically; Figma file key validated and URL-encoded; `findFfBinary` no longer searches the current directory (project-local `.hyperframes/bin` now requires `HYPERFRAMES_ALLOW_PROJECT_BIN=1`); media `src` query/fragment stripped and escaping paths not probed.
- **shader-transitions:** shader/program leaks on compile failure fixed; GL resources disposed on `beforeunload`.
- **Registry:** `us-map`, `us-map-bubble`, `spain-map` TopoJSON inlined (no render-time fetch, timeline registered synchronously); four transition blocks now `paused: true`; `glass-shard-title` font-preload gets `class="clip"`.
- **CI:** `canary-sunset.yml` Bun pinned to 1.4.2 (nothing in the repo pins one — change if desired); `timeout-minutes` added to `canary-sunset`, `codeql`, `fast-video-validation`.

### Behaviour changes to be aware of

- HTTP render callers passing an absolute `outputPath` outside the renders dir are now rejected.
- `previewUrl` must be public **https** (http/localhost rejected).
- Producer binds loopback by default — containers/k8s need `PRODUCER_HOST=0.0.0.0`.
- Project-local ffmpeg in `.hyperframes/bin` and the cwd are no longer picked up automatically.
- Existing tests rewritten because they asserted the old behaviour: `files.pathSafety.test.ts` (upload `..` names), `timingCompiler.test.ts` (tag with `>` in an attribute), `waapi.test.ts` and `init.test.ts` (finish/onLoad semantics), `ffBinaries.test.ts` (cwd / project-bin).

---

## 4. Verification status (be skeptical of anything marked ⚠)

| Check                                                           | Result                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bun run build` (all packages)                                  | ✅ exit 0 (run after all edits)                                                                                   |
| oxlint / oxfmt on changed files                                 | ✅ clean (per agent and me)                                                                                       |
| `tsc --noEmit`                                                  | ✅ clean in studio-server, producer, engine, core, parsers, cli, studio, shader-transitions                       |
| New regression tests                                            | ✅ written for nearly every fix and passing in their own files                                                    |
| **Full `bun run test`**                                         | ⚠ **never finished** — the process was stopped twice (session ended)                                              |
| Failures seen in the partial runs                               | ⚠ see below — **not compared against a clean baseline**                                                           |
| Running preview                                                 | ⚠ the preview at `localhost:3002` was started from the **old** `dist` and has not been restarted on the new build |
| Visual check of the three maps                                  | ⚠ not done; only lint + script parse                                                                              |
| Real render / real ffmpeg / real gcloud/sam / 413 via live Vite | ⚠ not exercised                                                                                                   |

**Failures seen in partial full-suite runs** (baseline unknown; some are clearly Windows/environment, but this is inference):

- studio-server: 3 backup-ENOTDIR tests in `files.test.ts`, 2 dangling-symlink tests in `files.pathSafety.test.ts` — **confirmed failing before our changes** (checked with changes stashed).
- core: 2 `htmlBundler` symlink EPERM tests, 1 `cssSelector` test.
- parsers: `assetResolution` name-too-long, **`ffBinaries` ×2 (in a file we changed — must be baselined)**, `gsapWriterAcorn.motionPath`, `hfIds`.
- producer (12): `htmlCompiler.parity` ×3, `captureHdrResources`, `hyperframeRuntimeLoader`, `mediaProbeConcurrency`, `renderCommitCancellation`, `ffprobeArgvContract` ×2, `audioPadTrim.integration` ×2, `renderDirOwner`, `segmentManifest`, plus `audioPadTrim` `/tmp` ENOENT. **`htmlCompiler.parity`, `ffprobeArgvContract`, `mediaProbeConcurrency` and `renderCommitCancellation` touch code we edited — treat as suspect until baselined.**
- player: 7 (`hyperframes-player`, `range-playback`) — not touched by us.
- aws-lambda (~8) / gcp-cloud-run (2): mostly ~5 s timeouts — likely environment.
- sdk: 1 flaky (`iframe.sync`) in one run, passed in the next.
- engine `browserManager`: 9 failures were `bun ENOENT` from PATH (not a code issue).

### Unexpected working-tree changes from the build

`bun run build` regenerated ~174 files under `docs/` (catalog `.mdx`, `docs/public/catalog*`, `docs/docs.json`, one deleted `simulated-cursor.mdx`) plus `registry/registry.json` and `registry/catalog-artifact/local-vectors.*`. These are **build output, not part of the fixes**. Decide whether to keep or discard them before committing; the registry-block fixes legitimately change a few of them (map blocks, transitions).

---

## 5. What still needs to be done / created

### Verify first (highest value)

1. **Finish the full test run** (`bun run test`, in a terminal that stays open) and **baseline every failure** against clean `main` (e.g. a `git worktree` of `HEAD`). Priority: the `ffBinaries` ×2, producer `htmlCompiler.parity`, `ffprobeArgvContract`, `mediaProbeConcurrency`, `renderCommitCancellation`.
2. **Restart `hyperframes preview`** on the new build and smoke-test: file edit, render, download/seek (Range), delete render, upload.
3. **Run `npx hyperframes check`** (browser gate) and a real render on the three map blocks and the four transition blocks to confirm visual parity.
4. **Confirm the Figma S3 bucket names** (`figma-alpha-api`, `figma-alpha`) — they were a best guess; wrong names block legitimate imports.
5. Decide on the **generated `docs/` and `registry/` churn**, then commit in logical conventional-commit chunks (do not commit `demo.mp4`, `demo-showcase/`, `test-video/`).

### Known gaps in the fixes

- **DNS rebinding** is still possible against the studio API (Origin guard can't stop it). Needs a loopback-only `Host` allowlist — may conflict with `HYPERFRAMES_PREVIEW_HOST` LAN use.
- **Producer has no authentication.** Loopback bind reduces exposure; an optional bearer token is still recommended.
- **Figma `nextId` race** (duplicate `image_NNN` ids under concurrent imports) — needs a lock around mint+append.
- **Registry maps still load gsap/d3/topojson `<script>` tags from jsDelivr** at render time — vendor them locally.
- `entryFile` / external-asset containment over HTTP in the producer is only partly addressed (outputPath, ids, SSRF were fixed; the `entryFile` outside-project read was not).
- Producer-side `-i` uses (`audioPadTrim`, `gifEncodeArgs`, regression harness) don't get the protocol whitelist (they read pipeline-produced files).
- Studio render-job TTL cleanup is disabled when `NODE_ENV=production`.
- `audioExtractor.ts` in producer is dead code — delete it.

### Tests that should be created

- Producer graceful-shutdown test; `/outputs/:token` route test (only the content-type helper is tested).
- shader-transitions dispose-path test; browserManager close-timeout call-site tests.
- Studio-server: integration test for the Origin guard through a real HTTP server (the in-process test runner strips `Origin`/`Host`).
- Windows-specific coverage for the gcloud/sam shim against real binaries.

### Housekeeping

- Align dependency ranges across packages (`puppeteer-core`, `gsap`, `hono`, `tsx`, `typescript`, `postcss`, `postcss-selector-parser`).
- `packages/sdk-playground` is at 0.6.106 vs 0.8.137 everywhere else — confirm intentional.
- Commit the refreshed `bun.lock`.
- `CLAUDE.md` line ~58 still says "20 AI agent skills" in an example sentence.
- Pin Bun in `ci.yml` / preflight (currently unpinned) and decide whether 1.4.2 is the right pin.

### Not audited (coverage gaps)

`packages/lint` and `packages/parsers` (beyond a few files), `packages/sdk`, `packages/aws-lambda`, `packages/gcp-cloud-run`, most of `skills/` and `registry/examples`, and the `docs/` site. A second pass over these is recommended.
