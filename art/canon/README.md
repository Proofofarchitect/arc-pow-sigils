# art/canon — House Card canon

**Single source of truth** for the House Card art system: one 128×128 master
plus the markup (masks, zones, anchors, palette policy) that every layer is built
from. Layers are composed PNG → SVG in this z-order:

`background → body → outfit → face → hair → eyes → headwear → tool → companion → bug → legendary`

`ANCHORS.json` is the authoritative config. `make_canon.py` regenerates every
derived file from it — deterministically and idempotently (`python3 art/canon/make_canon.py`).

## File index

| Path | What |
|---|---|
| `ANCHORS.json` | Config: canvas, palette policy, paths, z-order, rules, slot zones, golden rules |
| `master.png` | Approved 128×128 master (copy of `art/ai/out/master/m03_proflash_s303.png`) |
| `masks/face.png` | Patch region rect y[30,88) x[56,128) |
| `masks/eyes.png` | Patch region rect y[40,70) x[56,128) |
| `masks/headwear.png` | Patch region rect y[0,120) x[0,128) |
| `masks/outfit.png` | Outfit cutout mask (byte-copy of `mask_v3_tuned.png`) |
| `masks/hair_front.png` | Hair mask (head-top + sides, minus face/eyes zone). **WIP**; `hair_back.png` = provisional copy |
| `masks/tool_zone.png` | Sprite zone x[80,126) y[74,127) — bottom-right |
| `masks/companion_zone.png` | Sprite zone x[2,48) y[72,127) — bottom-left |
| `masks/bug_zone.png` | Sprite zone x[2,46) y[2,46) — top-left |
| `masks/legendary_chip_zone.png` | Emblem-chip zone x[84,124) y[2,42) — **provisional** |
| `guides_template.png` | Master + 1px magenta outlines of every region/zone |
| `guides_template_x4.png` | Same, nearest ×4 for pixel work |
| `palette/*_reference.{png,txt}` | Reference palettes (swatch strip + hex list) |

## How to use

- **Draw/edit accessories** with `guides_template.png` open as an overlay: it shows
  where each region/zone lives (magenta = 1px outline). Never ship the guides file.
- **Edit-from-master recipe:** start from `master.png`, change only inside the
  target region/mask, then extract the diff-vs-master patch (threshold 18, alpha 16,
  morph min-neighbors 2). Outside the mask **pixels must equal the master** (`inpaint_rule`).
- **Pixel-rect convention:** all rects are **half-open** — `x∈[x0,x1)`, `y∈[y0,y1)`.
- **Palettes are references, not enforced caps.** The standing standard is
  per-file: **CARD ≤ 64**, **SCENE ≤ 112** colors (median-cut, no dither). The
  `palette_*_reference` files are just the union of approved assets (CARD = trait
  assets under `art/ai/out/traits/` minus Background, plus master; SCENE =
  Background `_128` files), capped for convenience.

## WIP / caveats

- **Hair mask** (`hair_front/back`) is a coarse replication of the hand-built logic
  in `art/svg/import_catalog.py` — status `WIP mask — clarify`.
- **Legendary chip zone** is `provisional`; **Golden** (house-cat / fat-rat) is
  `rules only` — not in the 16-card mix. Root contact sheets are excluded from palettes.