# Setup and providers — install, RAM ladders, forcing a provider

## Setup

media-use needs no account. Only `ffmpeg`/`ffprobe` are strictly required for the tool to run at all; everything else is an optional local tool that unlocks one capability. Verify setup with:

```bash
npx hyperframes media-use resolve --doctor
```

## Providers

media-use holds no keys; every external tool owns its auth. Everything runs locally or through a tool you install and sign in to yourself: mflux for image, Kokoro for voice, Parakeet for transcription, and LTX for local video generation. `resolve` spec-checks AVAILABLE RAM for those local ladders (`describeModelLadder`); the agent can see the ladder and override.

| Type      | Provider / path                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bgm       | no catalog; generate with the audio engine (`audio/scripts/audio.mjs`: Lyria with your own Gemini key, else local MusicGen) or ingest a file with `--from` |
| sfx       | bundled sound-effects library (offline), then the local catalog index                                                                                      |
| image     | local mflux (RAM-graded), then the codex `image_gen` upsell                                                                                                |
| voice     | local **Kokoro** (free, on-device)                                                                                                                         |
| icon      | no catalog; ingest a file with `--from`, or use `--type logo` for brand marks                                                                              |
| logo      | theSVG (thesvg.org), then GitHub org avatar, then domain favicon (all free)                                                                                |
| grade/lut | local core-preset map, params look index, deterministic `buildCube` fallback                                                                               |
| video     | local LTX (`videogen` ladder)                                                                                                                              |

Local Kokoro (voice), mflux (image), and LTX (video) run on-device (free, private, offline once cached). The `codex` CLI remains the ChatGPT-sub image upsell. Cost rule (X4): the agent confirms before an agent-initiated paid call; a user-requested one just runs.

When a type has no available provider, `resolve` exits 1 with a clear message (and Kokoro/mflux print their enable command to stderr); it never silently produces nothing.

To force a specific generator (e.g. a user says "make this image with codex"), pass `--provider codex`: it pins resolution to that provider. See `references/operations.md` for the RAM ladders and provider recipes.

`--local-only` skips every network provider, leaving the project + global cache and any installed local provider.

## CLI tools used (what to run, and how to enable each)

`resolve` auto-cascades; each provider shells one CLI. Local tools are OPT-IN: install one to unlock its free, private, on-device path for that type.

| Tool               | Serves                                                                      | Install                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ffmpeg`/`ffprobe` | adopt probing, smart-grade signalstats, cut, duck bake, loudnorm            | system package (`brew install ffmpeg`)                                                                                                                                                      |
| `mflux-generate`   | local image gen (FLUX), best-for-RAM                                        | `uv venv ~/.venvs/mflux && VIRTUAL_ENV=~/.venvs/mflux uv pip install mflux==0.9.6`                                                                                                          |
| `codex`            | image gen upsell (ChatGPT sub)                                              | Codex CLI, logged in via ChatGPT (owns its own auth)                                                                                                                                        |
| `parakeet-mlx`     | local transcription (default ASR, best) on Apple Silicon                    | `uv venv ~/.venvs/parakeet && VIRTUAL_ENV=~/.venvs/parakeet uv pip install parakeet-mlx`                                                                                                    |
| `ltx-2-mlx`        | local video gen                                                             | `git clone https://github.com/dgrauet/ltx-2-mlx && cd ltx-2-mlx && uv sync --all-extras`                                                                                                    |
| `npx hyperframes`  | Kokoro TTS (voice), Parakeet or whisper.cpp (transcribe), remove-background | via the hyperframes CLI; Parakeet on macOS, Windows and glibc 2.32+ Linux: `npx hyperframes models install parakeet`; whisper.cpp is built on first use (Homebrew on macOS, else git+cmake) |

The RAM-graded local-model shortlist + exact per-tier install/invoke lives in `scripts/lib/local-models.mjs` (the agent can read `describeModelLadder(cap, specs)` to see which model fits this machine). Without a tool on PATH, its provider prints a one-line diagnostic to stderr and resolve falls through where another provider exists (e.g. no `mflux` -> codex image upsell; no `parakeet-mlx` -> whisper.cpp).
