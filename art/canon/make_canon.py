#!/usr/bin/env python3
"""make_canon.py — reproducible generator for the House Card "canon".

Single source of truth = art/canon/ANCHORS.json.
This script (re)creates, deterministically and idempotently:

  art/canon/master.png            copy of the approved 128x128 master
  art/canon/masks/*.png           L-mode 128x128 masks (face/eyes/headwear/outfit
                                  hair_front/hair_back/tool_zone/companion_zone/
                                  bug_zone/legendary_chip_zone)
  art/canon/guides_template.png   master + 1px magenta region outlines
  art/canon/guides_template_x4.png  nearest x4 of the above
  art/canon/palette/palette_card_reference.{png,txt}
  art/canon/palette/palette_scene_reference.{png,txt}

Rect convention: pixel rects are HALF-OPEN  ->  x in [x0,x1), y in [y0,y1).

Repo root is resolved from __file__ by walking up until a dir containing 'art/' is found.
No network, no randomness, no timestamps -> running twice yields identical output.
"""
import json
import os
import shutil
from PIL import Image, ImageDraw

# --------------------------------------------------------------------------- paths
def repo_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while True:
        if os.path.isdir(os.path.join(d, "art")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("could not locate repo root (no 'art/' above %s)" % __file__)
        d = parent


ROOT = repo_root()
CANON = os.path.join(ROOT, "art", "canon")
MASKS = os.path.join(CANON, "masks")
PALETTE = os.path.join(CANON, "palette")
ANCHORS_PATH = os.path.join(CANON, "ANCHORS.json")

W = H = 128
MAGENTA = (255, 0, 255, 255)

A = json.load(open(ANCHORS_PATH))
S = A["slots"]

MASTER_SRC = os.path.join(ROOT, "art", "ai", "out", "master", "m03_proflash_s303.png")
OUTFIT_SRC = os.path.join(ROOT, "art", "ai", "out", "master", "mask_v3_tuned.png")
TRAITS = os.path.join(ROOT, "art", "ai", "out", "traits")
SPECTACLES = os.path.join(TRAITS, "Face", "Spectacles.png")

for d in (CANON, MASKS, PALETTE):
    os.makedirs(d, exist_ok=True)


# --------------------------------------------------------------------------- helpers
def rect_mask(y0, y1, x0, x1):
    """L-mode mask, white (255) on the half-open rect [y0,y1) x [x0,x1)."""
    im = Image.new("L", (W, H), 0)
    px = im.load()
    for y in range(y0, y1):
        for x in range(x0, x1):
            px[x, y] = 255
    return im


def region_to_rect(region):
    return region["y0"], region["y1"], region["x0"], region["x1"]


def zone_to_rect(zone):
    return zone["y0"], zone["y1"], zone["x0"], zone["x1"]


# --------------------------------------------------------------------------- 1. master
def make_master():
    dst = os.path.join(CANON, "master.png")
    shutil.copyfile(MASTER_SRC, dst)
    im = Image.open(dst)
    assert im.size == (W, H), "master must be %dx%d, got %s" % (W, H, im.size)
    return dst


# --------------------------------------------------------------------------- 2. masks
def make_masks():
    master = Image.open(MASTER_SRC).convert("RGBA")
    out = {}

    # patch / region masks straight from ANCHORS
    out["face.png"] = rect_mask(*region_to_rect(S["face"]["region"]))
    out["eyes.png"] = rect_mask(*region_to_rect(S["eyes"]["region"]))
    out["headwear.png"] = rect_mask(*region_to_rect(S["headwear"]["region"]))

    # outfit: exact copy of the approved tuned mask
    outfit = Image.open(OUTFIT_SRC).convert("L")
    assert outfit.size == (W, H)
    out["outfit.png"] = outfit

    # hair: replicate the hand-built logic of import_catalog.py (lines ~154-170):
    #   head-top + sides, minus the face/eyes patch zone where Spectacles differs from master.
    hm = [[False] * H for _ in range(W)]
    for y in range(0, 98):
        for x in range(W):
            if not (58 <= x < 116 and 44 <= y < 98):
                hm[y][x] = True
    spec = Image.open(SPECTACLES).convert("RGBA").load()
    m = master.load()
    for y in range(30, 88):
        for x in range(56, 128):
            a, s = m[x, y], spec[x, y]
            if abs(s[0] - a[0]) + abs(s[1] - a[1]) + abs(s[2] - a[2]) > 54:
                hm[y][x] = False
    hair = Image.new("L", (W, H), 0)
    hp = hair.load()
    for y in range(H):
        for x in range(W):
            if hm[y][x]:
                hp[x, y] = 255
    out["hair_front.png"] = hair
    out["hair_back.png"] = hair.copy()  # provisional: back == front for now

    # sprite zones
    out["tool_zone.png"] = rect_mask(*zone_to_rect(S["tool"]["zone"]))
    out["companion_zone.png"] = rect_mask(*zone_to_rect(S["companion"]["zone"]))
    out["bug_zone.png"] = rect_mask(*zone_to_rect(S["bug"]["zone"]))
    out["legendary_chip_zone.png"] = rect_mask(*zone_to_rect(S["legendary"]["zone"]))

    for name, img in out.items():
        img.save(os.path.join(MASKS, name))
    return out


# --------------------------------------------------------------------------- 3. guides
def make_guides():
    master = Image.open(os.path.join(CANON, "master.png")).convert("RGBA")
    g = master.copy()
    dr = ImageDraw.Draw(g)

    def outline(y0, y1, x0, x1):
        # 1px inclusive rectangle covering the half-open pixel rect
        dr.rectangle([x0, y0, x1 - 1, y1 - 1], outline=MAGENTA)

    outline(*region_to_rect(S["face"]["region"]))       # face region
    outline(*region_to_rect(S["eyes"]["region"]))       # eyes region
    outline(*region_to_rect(S["headwear"]["region"]))   # headwear region (full width up to y120)
    dr.line([(0, A["rules"]["headwear_region_max_y"]), (W - 1, A["rules"]["headwear_region_max_y"])],
            fill=MAGENTA, width=1)                      # y=120 line

    outfit_bbox = Image.open(os.path.join(MASKS, "outfit.png")).getbbox()
    if outfit_bbox:
        dr.rectangle([outfit_bbox[0], outfit_bbox[1], outfit_bbox[2] - 1, outfit_bbox[3] - 1], outline=MAGENTA)

    outline(*zone_to_rect(S["tool"]["zone"]))           # tool zone
    outline(*zone_to_rect(S["companion"]["zone"]))      # companion zone
    outline(*zone_to_rect(S["bug"]["zone"]))            # bug zone
    outline(*zone_to_rect(S["legendary"]["zone"]))      # legendary chip zone

    g.save(os.path.join(CANON, "guides_template.png"))
    g.resize((W * 4, H * 4), Image.NEAREST).save(os.path.join(CANON, "guides_template_x4.png"))


# --------------------------------------------------------------------------- 4. palettes
def collect_colors(files):
    colors = set()
    for f in files:
        im = Image.open(f).convert("RGBA")
        for cnt, c in (im.getcolors(maxcolors=1 << 20) or []):
            if c[3] > 0:
                colors.add((c[0], c[1], c[2]))
    return colors


def card_files():
    """Approved CARD assets: per-trait PNGs in traits/<slot>/ (all slots except Background).
    Contact sheets and preview strips at the traits root are NOT assets -> excluded."""
    files = []
    for name in sorted(os.listdir(TRAITS)):
        sub = os.path.join(TRAITS, name)
        if not os.path.isdir(sub) or name == "Background":
            continue
        for f in sorted(os.listdir(sub)):
            if f.lower().endswith(".png"):
                files.append(os.path.join(sub, f))
    return files


def scene_files():
    bg = os.path.join(TRAITS, "Background")
    return [os.path.join(bg, f) for f in sorted(os.listdir(bg)) if f.endswith("_128.png")]


def to_palette(colors, cap):
    """Deterministic sorted union; cap via PIL median-cut (no dither) when over budget."""
    colors = sorted(colors)
    if len(colors) <= cap:
        return colors
    n = len(colors)
    flat = Image.new("RGB", (n, 1))
    flat.putdata(colors)
    q = flat.quantize(cap, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
    pal = q.getpalette()[: cap * 3]
    res, seen = [], set()
    for i in range(0, len(pal), 3):
        c = (pal[i], pal[i + 1], pal[i + 2])
        if c not in seen:
            seen.add(c)
            res.append(c)
    return res


def write_palette(name, colors):
    cols = 16
    sw = 16
    rows = (len(colors) + cols - 1) // cols
    img = Image.new("RGB", (cols * sw, max(1, rows) * sw), (0, 0, 0))
    dr = ImageDraw.Draw(img)
    for i, c in enumerate(colors):
        cx, cy = (i % cols) * sw, (i // cols) * sw
        dr.rectangle([cx, cy, cx + sw - 1, cy + sw - 1], fill=c)
    img.save(os.path.join(PALETTE, name + ".png"))
    with open(os.path.join(PALETTE, name + ".txt"), "w") as fh:
        fh.write("".join("#%02x%02x%02x\n" % c for c in colors))
    return len(colors)


# --------------------------------------------------------------------------- main
def main():
    master = make_master()
    make_masks()
    make_guides()

    card_union = collect_colors(card_files() + [master])
    n_card = write_palette("palette_card_reference", to_palette(card_union, A["palette_policy"]["card_max_colors"]))

    scene_union = collect_colors(scene_files())
    n_scene = write_palette("palette_scene_reference", to_palette(scene_union, A["palette_policy"]["scene_max_colors"]))

    print("make_canon OK")
    print("  master      : %s" % os.path.relpath(master, ROOT))
    print("  masks       : %d" % len(os.listdir(MASKS)))
    print("  card palette: %d colors (union %d, cap %d)" % (n_card, len(card_union), A["palette_policy"]["card_max_colors"]))
    print("  scene palette: %d colors (union %d, cap %d)" % (n_scene, len(scene_union), A["palette_policy"]["scene_max_colors"]))


if __name__ == "__main__":
    main()
