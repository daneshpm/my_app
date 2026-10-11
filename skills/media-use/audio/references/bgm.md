# Background music (BGM)

One music bed per composition, produced by the shared audio engine (`scripts/audio.mjs` → `scripts/lib/bgm.mjs`). There is no hosted music catalog and no account: music is **generated** locally or with your own key (Lyria → MusicGen). There is **no `npx hyperframes bgm` command**; the engine spawns `scripts/lyria-recipe.py` or an inline MusicGen script directly. To use an existing track instead, ingest it with `resolve --from <file> --type bgm`.

## Driving it from the request

`audio_request.json` → `bgm: { mode?, query?, prompt? }`:

- **`mode`** — `generate | none`. Omit for `generate`. `retrieve` was removed with the hosted catalog: an explicit `retrieve` is skipped with an anomaly (never silently turned into a detached generate job).
- **`query`** — the mood, used as a fallback prompt seed (e.g. a storyboard's `music:` field, falling back to `message` → `arc` → `"calm cinematic underscore"`).
- **`prompt`** — an explicit full prompt for generation; omit and the engine infers one (see Mood inference). Optional `blob` / `archetype` / `arc` feed that inference.

The engine keeps a file of yours already at the output name: the engine writes the next free name (`track-2.mp3`), reports it as an anomaly, and `bgm.path` carries the real path.

## Generation — Lyria → MusicGen

Spawned **detached** so voice work isn't blocked; `audio_meta.bgm_pending: true` and `bgm_pid` / `bgm_log` are set until it finishes. **Run `scripts/wait-bgm.mjs` before assembling** — it polls the output file / process / log, detects crashes, and writes `bgm_status.json` (`status: ready | failed | timeout | disabled`). A failed/absent track is simply omitted; it never blocks voice/SFX.

| Order | Provider                             | Env / deps                                                                            | Speed                                   | Quality                     |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------- |
| 1     | Google Lyria RealTime                | `$GEMINI_API_KEY` or `$GOOGLE_API_KEY` + `google-genai` (auto-installed on demand)    | Real-time stream (≈ requested duration) | Production-grade            |
| 2     | MusicGen (`facebook/musicgen-small`) | Python `transformers + torch + soundfile + numpy` (~300 MB first run; auto-installed) | Slow on CPU; fast on Apple MPS / CUDA   | Decent; prompt-only control |

Output → `assets/bgm/track.wav`, target = total voice duration. MusicGen generates **one** seed clip (≤28–30s, under the decoder's positional limit) then crossfade-loops it up to the target (or trims down if shorter), avoiding per-segment seams. Backend selection is by what can actually **run**: Lyria only when `import google.genai` succeeds, else MusicGen; if neither can be made to run, BGM is skipped (voice + SFX still render).

## Mood inference (the generate prompt)

`inferBgmPrompt()` in `scripts/lib/bgm.mjs`: an explicit `prompt` wins; otherwise industry-keyword **base** → narrative-**archetype** shape → emotional-**arc** tiebreaker.

| Match in `blob` / `query`                              | Base prompt                                                                 | BPM |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | --- |
| `crypto / nft / web3 / defi / token / blockchain`      | atmospheric electronic, deep bass, futuristic synths, restrained percussion | 100 |
| `finance / fintech / bank / payment / invest / wealth` | calm cinematic, soft strings, subtle piano, restrained percussion           | 92  |
| `creative / agency / design / studio / art / brand`    | playful electronic, warm pads, light percussion                             | 115 |
| _(default: SaaS / tech / platform)_                    | uplifting corporate tech, bright modern piano with synth pads               | 108 |

Archetype then reshapes the arc — PAS → "MINOR to MAJOR" build; BAB / future-pacing → aspirational rising; feature-cascade → +10 BPM driving; demo-loop → −8 BPM minimal. The emotional arc breaks remaining ties (tension→relief, excitement, trust/reassurance).

## Lyria knobs (direct recipe use)

The engine bakes BPM / scale into the **prompt text** (via the inference above) and passes only `--output` / `--duration` / `--prompt` to the recipe. If you invoke `scripts/lyria-recipe.py` directly you can also set: `--bpm` (90–110 calm, 110–130 energetic), `--brightness` (0–1, ≥0.7 promotional), `--density` (0–1, higher = fuller), `--scale` (`MAJOR` / `MINOR` / `PENTATONIC` / …), `--negative-prompt` (styles to exclude). MusicGen ignores all of these — put the mood in the prompt.

## Failure modes

| Failure                                       | Behavior                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Explicit `retrieve`                           | Skipped with an anomaly (mode removed). Use `mode: generate` or omit `mode`.             |
| Neither Lyria nor MusicGen can run (generate) | `bgm` disabled with a `pip install …` hint. Voice + SFX still render.                    |
| Generate still rendering at assemble time     | `bgm_pending: true`; `wait-bgm.mjs` waits/checks and writes `bgm_status.json` first.     |
| Generate crashed                              | `wait-bgm.mjs` → `bgm_status.json { status: "failed" }`; the `<audio>` track is omitted. |

BGM failure never blocks a render.
