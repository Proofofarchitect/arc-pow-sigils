#!/usr/bin/env python3
"""build_review.py — Legendary emblem-chip REVIEW sheet.

Builds art/canon/legendary_chips/_candidates/REVIEW.png:
  for each chip, one row of three panels (each scaled x3, nearest):
    [ Legendary full art ] [ element chip ] [ mock composed card ]
  Panels sit on a gray checkerboard so transparency is visible.
  The mock card = background__house-grid + body__base + outfit__house-hoodie
  (art/svg/catalog/layers_png/) with the chip placed top-right (right edge at
  x=124, top y=2).

Usage: python3 art/canon/legendary_chips/build_review.py
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))  # .../pow_nft_launch_arc
LEG = os.path.join(ROOT, "art", "ai", "out", "traits", "Legendary")
LAY = os.path.join(ROOT, "art", "svg", "catalog", "layers_png")
OUT = os.path.join(HERE, "_candidates", "REVIEW.png")
SCALE = 3
PAD = 12
LABEL_H = 22

CHIPS = [
    ("10b-mint", "10B Mint.png"),
    ("gas-is-a-dollar", "Gas is a Dollar.png"),
    ("sept-16", "Sept 16.png"),
    ("house-opens", "House Opens.png"),
    ("jeremy-drop-in", "Jeremy Drop-in.png"),
]
MOCK_LAYERS = ["background__house-grid.png", "body__base.png", "outfit__house-hoodie.png"]


def checker(w, h, cell=8):
    im = Image.new("RGB", (w, h), (150, 150, 150))
    d = ImageDraw.Draw(im)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(110, 110, 110))
    return im


def panel_on_checker(rgba):
    """Return a scaled RGB panel: RGBA composited onto a gray checkerboard."""
    big = rgba.resize((rgba.width * SCALE, rgba.height * SCALE), Image.NEAREST)
    base = checker(big.width, big.height)
    base.paste(big, (0, 0), big)
    return base


def mock_card(chip):
    card = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    for fn in MOCK_LAYERS:
        p = os.path.join(LAY, fn)
        if os.path.exists(p):
            card.alpha_composite(Image.open(p).convert("RGBA"))
    # place chip top-right: right edge at x=124, top y=2
    x0 = 124 - chip.width
    y0 = 2
    layer = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    layer.paste(chip, (x0, y0))
    card.alpha_composite(layer)
    return card


def main():
    rows = []
    for slug, legacy in CHIPS:
        art_p = os.path.join(LEG, legacy)
        chip_p = os.path.join(HERE, f"{slug}.png")
        full = Image.open(art_p).convert("RGBA") if os.path.exists(art_p) \
            else Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        chip = Image.open(chip_p).convert("RGBA") if os.path.exists(chip_p) \
            else Image.new("RGBA", (0, 0), (0, 0, 0, 0))
        card = mock_card(chip)
        # full art is 128x128 -> pad to a common panel box so rows align
        cand = max(full.width, full.height, card.width, card.height)
        rows.append((slug, chip.size,
                     [panel_on_checker(full), panel_on_checker(chip), panel_on_checker(card)]))

    panel_w = max(p.width for _, _, ps in rows for p in ps)
    row_h = max(p.height for _, _, ps in rows for p in ps)
    n = len(rows)
    W = PAD + (panel_w + PAD) * 3
    H = PAD + (row_h + LABEL_H + PAD) * n
    sheet = Image.new("RGB", (W, H), (24, 24, 28))
    d = ImageDraw.Draw(sheet)

    for i, (slug, csize, panels) in enumerate(rows):
        yy = PAD + i * (row_h + LABEL_H + PAD)
        d.text((PAD, yy), f"{slug}   chip {csize[0]}x{csize[1]}  (full | chip | mock card)",
               fill=(255, 220, 80))
        for j, p in enumerate(panels):
            sheet.paste(p, (PAD + j * (panel_w + PAD), yy + LABEL_H))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT)
    print(f"[review] wrote {OUT} ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    main()
