#!/usr/bin/env python3
"""build_four_review.py — FOCUSED review sheet for the 4 UNDECIDED Legendary items.

For each of the four undecided slugs it builds one row of five panels
(each scaled x3, nearest, on a gray checkerboard):

    [ full art ] [ chip TR ] [ chip BR ] [ chip TL ] [ mock card w/ TR chip ]

Panels sit on a dark sheet with yellow-ish labels. Per row we print the chip
bounding-box size in px and the % of non-transparent pixels, so near-empty /
meaningless scraps are obvious and NOT hidden.

Outputs:
  art/canon/legendary_chips/_candidates/FOUR_REVIEW.png
  art/canon/legendary_chips/_candidates/FOUR_REVIEW.txt   (same table as stdout)
  ~/Downloads/pow_nft_legendary4_review.png
  ~/Downloads/pow_nft_legendary4_review.jpg               (quality 92)

Usage: python3 art/canon/legendary_chips/build_four_review.py
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))  # .../pow_nft_launch_arc
LEG = os.path.join(ROOT, "art", "ai", "out", "traits", "Legendary")
LAY = os.path.join(ROOT, "art", "svg", "catalog", "layers_png")
CAND = os.path.join(HERE, "_candidates")
OUT_PNG = os.path.join(CAND, "FOUR_REVIEW.png")
OUT_TXT = os.path.join(CAND, "FOUR_REVIEW.txt")
DL_PNG = os.path.expanduser("~/Downloads/pow_nft_legendary4_review.png")
DL_JPG = os.path.expanduser("~/Downloads/pow_nft_legendary4_review.jpg")

SCALE = 3
PAD = 12
LABEL_H = 46          # two text lines per row
HEADER_H = 20

# slug -> source legendary art filename (full 128x128 overlay)
ITEMS = [
    ("economic-os", "Economic OS.png"),
    ("testnet-genesis", "Testnet Genesis.png"),
    ("queues-open", "Queues Open.png"),
    ("the-silence", "The Silence.png"),
]
SUFFIXES = ["_tr", "_br", "_tl"]           # candidate order used in the row
MOCK_LAYERS = ["background__house-grid.png", "body__base.png", "outfit__house-hoodie.png"]

COL_TITLES = ["full x3", "TR x3", "BR x3", "TL x3", "mock(TR @124,2)"]


# --------------------------------------------------------------------------- #
# image helpers
# --------------------------------------------------------------------------- #
def checker(w: int, h: int, cell: int = 8) -> Image.Image:
    im = Image.new("RGB", (w, h), (150, 150, 150))
    d = ImageDraw.Draw(im)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(110, 110, 110))
    return im


def panel_on_checker(rgba: Image.Image) -> Image.Image:
    """Scaled RGB panel: RGBA composited onto a gray checkerboard."""
    big = rgba.resize((rgba.width * SCALE, rgba.height * SCALE), Image.NEAREST)
    base = checker(big.width, big.height)
    base.paste(big, (0, 0), big)
    return base


def mock_card(chip: Image.Image) -> Image.Image:
    """house-grid + body + hoodie, then chip placed top-right (right edge x=124, top y=2)."""
    card = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    for fn in MOCK_LAYERS:
        p = os.path.join(LAY, fn)
        if os.path.exists(p):
            card.alpha_composite(Image.open(p).convert("RGBA"))
    x0 = 124 - chip.width
    y0 = 2
    layer = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    layer.paste(chip, (x0, y0))
    card.alpha_composite(layer)
    return card


# --------------------------------------------------------------------------- #
# chip analysis
# --------------------------------------------------------------------------- #
def analyze(path: str) -> dict:
    """Return size / opaque count / coverage% / bbox / luminance range."""
    if not os.path.exists(path):
        return {"size": (0, 0), "opaque": 0, "cov": 0.0, "bbox": None,
                "minl": None, "maxl": None, "missing": True}
    im = Image.open(path).convert("RGBA")
    W, H = im.size
    px = im.load()
    minx, miny, maxx, maxy = W, H, -1, -1
    opaque = 0
    lo, hi = 999, -1
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a > 0:
                opaque += 1
                minx = min(minx, x); miny = min(miny, y)
                maxx = max(maxx, x); maxy = max(maxy, y)
                lum = (r * 299 + g * 587 + b * 114) // 1000
                lo = min(lo, lum); hi = max(hi, lum)
    if maxx < 0:                                   # fully transparent
        return {"size": (W, H), "opaque": 0, "cov": 0.0, "bbox": None,
                "minl": None, "maxl": None}
    return {"size": (W, H), "opaque": opaque,
            "cov": 100.0 * opaque / (W * H),
            "bbox": (maxx - minx + 1, maxy - miny + 1),
            "minl": lo, "maxl": hi}


def cov_color(cov: float) -> tuple:
    if cov < 10.0:
        return (255, 90, 90)        # near-empty scrap
    if cov < 20.0:
        return (255, 170, 60)       # sparse
    return (150, 230, 140)          # has substance


def note_for(a: dict) -> str:
    if a.get("missing"):
        return "MISSING FILE"
    if a["opaque"] == 0:
        return "FULLY EMPTY"
    if a["cov"] < 10.0:
        return "NEAR-EMPTY scrap"
    if a["cov"] < 20.0:
        return "sparse fragment"
    if a["maxl"] is not None and a["maxl"] < 40:
        return "very dark / detail-less"
    return "has content"


# --------------------------------------------------------------------------- #
# table (stdout + .txt)
# --------------------------------------------------------------------------- #
def build_table(rows: list) -> str:
    lines = []
    lines.append("FOUR_REVIEW — undecided LEGENDARY emblem-chip candidates")
    lines.append("all candidate chips are 40x40 pre-cut corner crops "
                 "(tl/tr/br) of the full 128x128 legendary art")
    lines.append("")
    hdr = f"{'slug':16} {'cand':4} {'size':8} {'opaque':>7} {'cov%':>7} " \
          f"{'bbox(px)':>9} {'lum min/max':>12}  note"
    lines.append(hdr)
    lines.append("-" * len(hdr))
    for slug, metrics in rows:
        for suf in SUFFIXES:
            a = metrics[suf]
            cand = suf.lstrip("_").upper()
            size = f"{a['size'][0]}x{a['size'][1]}"
            bbox = f"{a['bbox'][0]}x{a['bbox'][1]}" if a["bbox"] else "-"
            lum = f"{a['minl']}/{a['maxl']}" if a["minl"] is not None else "-"
            lines.append(f"{slug:16} {cand:4} {size:8} {a['opaque']:>7} "
                         f"{a['cov']:>6.1f}% {bbox:>9} {lum:>12}  {note_for(a)}")
        # per-slug verdict hint
        best = max(SUFFIXES, key=lambda s: metrics[s]["cov"])
        lines.append(f"{'':16} -> highest coverage: {best.lstrip('_').upper()} "
                     f"({metrics[best]['cov']:.1f}%)")
        lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# sheet
# --------------------------------------------------------------------------- #
def main() -> None:
    rows = []          # (slug, metrics dict keyed by suffix, panels list)
    for slug, leg in ITEMS:
        art_p = os.path.join(LEG, leg)
        full = (Image.open(art_p).convert("RGBA") if os.path.exists(art_p)
                else Image.new("RGBA", (128, 128), (0, 0, 0, 0)))

        chips = {}
        metrics = {}
        for suf in SUFFIXES:
            p = os.path.join(CAND, f"{slug}{suf}.png")
            chips[suf] = (Image.open(p).convert("RGBA") if os.path.exists(p)
                          else Image.new("RGBA", (0, 0), (0, 0, 0, 0)))
            metrics[suf] = analyze(p)

        tr_chip = chips["_tr"]
        card = mock_card(tr_chip)

        panels = [panel_on_checker(full)]
        panels += [panel_on_checker(chips[s]) for s in SUFFIXES]
        panels.append(panel_on_checker(card))

        rows.append((slug, metrics, panels))

    panel_w = max(p.width for *_, ps in rows for p in ps)
    row_h = max(p.height for *_, ps in rows for p in ps)
    n = len(rows)
    ncol = 5
    W = PAD + (panel_w + PAD) * ncol
    H = HEADER_H + PAD + (row_h + LABEL_H + PAD) * n
    sheet = Image.new("RGB", (W, H), (24, 24, 28))
    d = ImageDraw.Draw(sheet)

    # header: column titles
    for j, title in enumerate(COL_TITLES):
        x = PAD + j * (panel_w + PAD) + (panel_w - len(title) * 6) // 2
        d.text((max(PAD, x), 4), title, fill=(255, 220, 80))

    for i, (slug, metrics, panels) in enumerate(rows):
        yy = HEADER_H + PAD + i * (row_h + LABEL_H + PAD)
        title = f"{slug} | full | TR | BR | TL | mock(TR)"
        d.text((PAD, yy), title, fill=(255, 220, 80))

        # second line: bbox + coverage per candidate (color-coded)
        x = PAD
        for suf in SUFFIXES:
            a = metrics[suf]
            cand = suf.lstrip("_").upper()
            if a["bbox"]:
                seg = f"{cand} {a['bbox'][0]}x{a['bbox'][1]}px {a['cov']:.1f}%"
            else:
                seg = f"{cand} empty"
            col = cov_color(a["cov"])
            d.text((x, yy + 16), seg, fill=col)
            x += 11 * len(seg) + 18

        for j, p in enumerate(panels):
            cx = PAD + j * (panel_w + PAD) + (panel_w - p.width) // 2
            py = yy + LABEL_H
            sheet.paste(p, (cx, py))
            d.rectangle([cx - 1, py - 1, cx + p.width, py + p.height],
                        outline=(70, 70, 80))

    os.makedirs(CAND, exist_ok=True)
    sheet.save(OUT_PNG)

    table = build_table([(s, m) for s, m, _ in rows])
    with open(OUT_TXT, "w", encoding="utf-8") as fh:
        fh.write(table + "\n")
    print(table)

    # copy to owner's Downloads
    os.makedirs(os.path.dirname(DL_PNG), exist_ok=True)
    sheet.save(DL_PNG)
    sheet.convert("RGB").save(DL_JPG, quality=92)
    print(f"\n[four-review] wrote {OUT_PNG} ({sheet.width}x{sheet.height})")
    print(f"[four-review] wrote {OUT_TXT}")
    print(f"[four-review] wrote {DL_PNG}")
    print(f"[four-review] wrote {DL_JPG}")


if __name__ == "__main__":
    main()
