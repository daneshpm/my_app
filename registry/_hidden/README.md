# Hidden registry items

Everything under `registry/_hidden/` is **not** part of the live registry. It is not
listed in `registry/registry.json`, is not indexed for catalog search, has no docs
page, and cannot be installed with `tagreel add`.

## Why these items are hidden

Each block here shipped its binary assets (photos, PNG textures) from a third-party
CDN that this fork does not control: the `files[]` entries in its
`registry-item.json` carry a `url` instead of bytes in the tree. Without that CDN
the items cannot be installed or rendered, so they were removed from the live
registry rather than left pointing at a host we cannot vouch for.

| Group                                      | Items                                                     |
| ------------------------------------------ | --------------------------------------------------------- |
| `carousel-circle-1` ... `-5`               | image carousels                                           |
| `carousel-orbit-1` ... `-5`                | image carousels                                           |
| `carousel-path-1` ... `-5`                 | image carousels                                           |
| `carousel-text-circle-1` ... `-5`          | image carousels                                           |
| `carousel-vision-1` ... `-5`               | image carousels                                           |
| `frost-sequence-camera-orbit`              | WebGPU block, 2 PNG assets                                |
| `glass-shard-title`                        | WebGL block, 1 PNG asset                                  |

The manifests and compositions are kept exactly as they were, so nothing is lost
except the hosted bytes.

## Restoring one

1. **Check each asset's license first.** Several carousels use photographs of real
   people and artists whose redistribution rights are unclear. Do not re-host an
   image you cannot show you are allowed to redistribute; replace it with an image
   you own or that is clearly licensed.
2. Re-host the assets on storage you control (or commit small ones into the item's
   `assets/` folder) and update the `url` of each `files[]` entry, or drop the
   `url` and keep the file in the tree.
3. Move the folder back to `registry/blocks/<name>/`.
4. Add `{ "name": "<name>", "type": "tagreel:block" }` to `registry/registry.json`
   (`bun scripts/generate-registry-items.ts` indexes every directory), then
   rebuild the on-device catalog vectors (`scripts/catalog/build-local-vectors.ts`)
   and the docs catalog.
