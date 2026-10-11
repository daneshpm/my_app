# LUT library (authoring)

`index.json` is the agent-consumed catalog of color-grade looks. Each entry resolves
deterministically — no `.cube` bodies are committed to the repo.

Each look has:

- `id`, `description`, `tags`, `intensity` — matching + application metadata.
- `url` (optional) — a hosted `.cube` downloaded, validated, and frozen at resolve
  time, exactly like bgm/image assets.
- `params` (optional) — a deterministic `buildCube` spec used offline (`--local-only`)
  or as a fallback if the `url` download/validation fails.

An entry needs at least one of `url` or `params`; prefer both (CDN url with a params
fallback) so resolution is never blocked on the network.

## Adding a new look

1. Generate the `.cube` (e.g. `resolve -t lut --params '{...}'` or a graded export) and note the `params` that reproduce it.
2. Add an entry to `index.json` with those `params`. The bundled looks carry no hosted `url`, so they resolve deterministically offline.
3. Optionally host the `.cube` yourself and add its `url`; `params` stays as the fallback.
