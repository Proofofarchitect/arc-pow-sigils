#!/usr/bin/env python3
"""extract_legendary_chips.py — extract the Legendary "emblem chip" from each
Legendary full-art PNG.

TWO MODES
  rect (default)  — legacy behaviour. Reads coords.json and crops the box
                    verbatim from the Legendary source (element + whatever is
                    inside the box). See "RECT MODE" below.
  component       — canonical emblem-chip extraction. Isolates the *event
                    element* (the changed region vs art/canon/master.png),
                    cleans it morphologically, keeps the connected component(s)
                    that overlap a per-art seed box, and writes an element-only
                    RGBA chip (alpha = component mask dilated 1px). See
                    "COMPONENT MODE" below.

RECT MODE (unchanged CLI behaviour)
  Reads  art/canon/legendary_chips/coords.json  and, for every non-null entry,
  crops the box from the source Legendary full-art PNG and writes a single RGBA
  PNG (crop only, no resize) to art/canon/legendary_chips/<trait-slug>.png.

  coords.json SCHEMA (W4 — keep this shape)
    {
      "<trait-slug>": {"x0": <int>, "y0": <int>, "x1": <int>, "y1": <int>},
      "<other-slug>": null
    }
    - slug = lowercase(trait filename without .png), spaces -> dashes
             e.g. "Gas is a Dollar.png" -> "gas-is-a-dollar"
    - box  = half-open rect x in [x0,x1), y in [y0,y1) on the 128x128 canvas.
    - null = skip this trait.

COMPONENT MODE
  `--mode component` uses the embedded COMPONENT_SPEC (or --spec <json>) and
  for each slug writes an element-only RGBA chip to <out>/<slug>.png. It also
  (with --write-coords, default ON) records the *used* tight boxes back into
  coords.json so rect mode stays reproducible.

  Algorithm (per art, 128x128 canvas):
    1. build a raw "element" mask:
         strategy "diff"  -> |dRGB| sum > 54 OR |dA| > 16  vs art/canon/master.png
                             (legacy edit-from-master difference). Optional
                             colour_filter removes character pixels inside the
                             diff (used when the base render drifted).
         strategy "color" -> an explicit colour rule inside the element area
                             (used when the whole base render was regenerated,
                             so a diff-vs-master is the whole character and is
                             useless for isolating the element).
    2. morphological cleanup: keep only pixels with >=2 set 8-neighbours.
    3. connected components (BFS, 8-connectivity).
    4. keep component(s) overlapping the seed box with size >= min_size; their
       union is the selected element.
    5. tight bbox of the union = the chip crop rect.
    6. chip = crop of the Legendary art at bbox; alpha = union dilated 1px
       (clamped to the bbox). Pixels outside the element become transparent.

  Rationale for the two strategies: 3 of the 5 requested arts ("10B Mint",
  "Gas is a Dollar", "Sept 16") were regenerated from a *different* base render
  (median dRGB vs master ~ 0 but the silhouette is shifted), so the diff mask is
  the whole character. Those use colour rules. "House Opens" and "Jeremy
  Drop-in" were rendered edit-from-master (silhouette matches), so the diff mask
  cleanly isolates the element. See art/canon/legendary_chips/REPORT (session).

USAGE
  python3 art/canon/extract_legendary_chips.py                  # rect extract
  python3 art/canon/extract_legendary_chips.py --dry-run        # rect plan only
  python3 art/canon/extract_legendary_chips.py --coords <path> --out <dir>
  python3 art/canon/extract_legendary_chips.py --mode component [--dry-run]
  python3 art/canon/extract_legendary_chips.py --mode component --spec <json>
  python3 art/canon/extract_legendary_chips.py --mode component --no-write-coords

An EMPTY coords.json ({}) exits cleanly (exit code 0) with a message.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))            # .../art/canon
ROOT = os.path.dirname(os.path.dirname(_HERE))                # .../pow_nft_launch_arc
LEG_DIR = os.path.join(ROOT, "art", "ai", "out", "traits", "Legendary")
OUT_DIR = os.path.join(ROOT, "art", "canon", "legendary_chips")
COORDS = os.path.join(OUT_DIR, "coords.json")
MASTER = os.path.join(ROOT, "art", "canon", "master.png")
CANVAS = 128

# diff rules (from art/canon/ANCHORS.json rules.* — kept for compatibility)
DIFF_RGB_THRESHOLD = 54      # sum(|dR|,|dG|,|dB|) > 54
DIFF_ALPHA_THRESHOLD = 16    # |dA| > 16
MORPH_MIN_NEIGHBORS = 2      # keep pixels with >= 2 set 8-neighbours


# --------------------------------------------------------------------------- #
# shared helpers
# --------------------------------------------------------------------------- #
def slugify(name: str) -> str:
    return os.path.splitext(os.path.basename(name))[0].lower().replace(" ", "-")


def source_map(src_dir: str) -> dict[str, str]:
    """slug -> absolute source PNG path."""
    if not os.path.isdir(src_dir):
        return {}
    m: dict[str, str] = {}
    for fn in sorted(os.listdir(src_dir)):
        if fn.lower().endswith(".png"):
            m[slugify(fn)] = os.path.join(src_dir, fn)
    return m


def valid_box(b) -> bool:
    if not isinstance(b, dict):
        return False
    keys = ("x0", "y0", "x1", "y1")
    if not all(k in b for k in keys):
        return False
    if not all(isinstance(b[k], int) for k in keys):
        return False
    x0, y0, x1, y1 = b["x0"], b["y0"], b["x1"], b["y1"]
    return 0 <= x0 < x1 <= CANVAS and 0 <= y0 < y1 <= CANVAS


# --------------------------------------------------------------------------- #
# component mode spec
# --------------------------------------------------------------------------- #
# Each entry: source filename, seed box [x0,y0,x1,y1] (element area), strategy,
# colour rule / filter, min component size (px). Tuned on the 5 requested arts.
COMPONENT_SPEC: dict[str, dict] = {
    "10b-mint": {
        "source": "10B Mint.png",
        "seed": [44, 0, 127, 40],
        "strategy": "color", "color": "neon",
        "min_size": 200,
    },
    "gas-is-a-dollar": {
        "source": "Gas is a Dollar.png",
        "seed": [4, 2, 48, 44],
        "strategy": "color", "color": "gold",
        "min_size": 200,
    },
    "sept-16": {
        "source": "Sept 16.png",
        "seed": [72, 0, 128, 60],
        "strategy": "color", "color": "pale",
        "min_size": 200,
        "close": 1, "fill_holes": True,
    },
    "house-opens": {
        "source": "House Opens.png",
        "seed": [80, 40, 128, 100],
        "strategy": "diff", "color_filter": "house",
        "min_size": 300,
    },
    "jeremy-drop-in": {
        "source": "Jeremy Drop-in.png",
        "seed": [92, 46, 128, 86],
        "strategy": "diff",
        "min_size": 200,
    },
}


# --------------------------------------------------------------------------- #
# mask primitives (numpy if available, else pure python fallback)
# --------------------------------------------------------------------------- #
def _has_numpy():
    try:
        import numpy  # noqa: F401
        return True
    except Exception:
        return False


def load_rgba(path):
    from PIL import Image
    return Image.open(path).convert("RGBA")


def diff_mask(leg, master):
    """Per-pixel element mask from a Legendary/master pair (RGBA)."""
    w, h = leg.size
    lp = leg.load()
    mp = master.load()
    out = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            lr, lg, lb, la = lp[x, y]
            mr, mg, mb, ma = mp[x, y]
            d = abs(lr - mr) + abs(lg - mg) + abs(lb - mb)
            if d > DIFF_RGB_THRESHOLD or abs(la - ma) > DIFF_ALPHA_THRESHOLD:
                out[y][x] = True
    return out


def clean_mask(mask, min_neighbors=MORPH_MIN_NEIGHBORS):
    """Drop isolated pixels: keep only set pixels with >= min_neighbors set 8-neighbours."""
    h = len(mask)
    w = len(mask[0]) if h else 0
    out = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if not mask[y][x]:
                continue
            n = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy][xx]:
                        n += 1
            if n >= min_neighbors:
                out[y][x] = True
    return out


def dilate1(mask):
    h = len(mask)
    w = len(mask[0]) if h else 0
    out = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if not mask[y][x]:
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w:
                        out[yy][xx] = True
    return out


def fill_holes(mask):
    """Fill enclosed transparent regions (flood the background from the border)."""
    h = len(mask)
    w = len(mask[0]) if h else 0
    reach = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not mask[y][x] and not reach[y][x]:
                reach[y][x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y][x] and not reach[y][x]:
                reach[y][x] = True
                q.append((y, x))
    while q:
        cy, cx = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = cy + dy, cx + dx
                if 0 <= yy < h and 0 <= xx < w and not mask[yy][xx] and not reach[yy][xx]:
                    reach[yy][xx] = True
                    q.append((yy, xx))
    return [[mask[y][x] or (not reach[y][x]) for x in range(w)] for y in range(h)]


def components(mask):
    """8-connected components -> list of {size, bbox:(x0,y0,x1,y1), pix:[(x,y)]}."""
    h = len(mask)
    w = len(mask[0]) if h else 0
    seen = [[False] * w for _ in range(h)]
    comps = []
    for y in range(h):
        for x in range(w):
            if mask[y][x] and not seen[y][x]:
                q = deque([(y, x)])
                seen[y][x] = True
                pix = []
                while q:
                    cy, cx = q.popleft()
                    pix.append((cx, cy))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            if dx == 0 and dy == 0:
                                continue
                            yy, xx = cy + dy, cx + dx
                            if 0 <= yy < h and 0 <= xx < w and mask[yy][xx] and not seen[yy][xx]:
                                seen[yy][xx] = True
                                q.append((yy, xx))
                xs = [p[0] for p in pix]
                ys = [p[1] for p in pix]
                comps.append({"size": len(pix),
                              "bbox": (min(xs), min(ys), max(xs) + 1, max(ys) + 1),
                              "pix": pix})
    comps.sort(key=lambda c: -c["size"])
    return comps


def _overlap(bb, seed):
    x0, y0, x1, y1 = bb
    sx0, sy0, sx1, sy1 = seed
    ix0, iy0 = max(x0, sx0), max(y0, sy0)
    ix1, iy1 = min(x1, sx1), min(y1, sy1)
    if ix0 >= ix1 or iy0 >= iy1:
        return 0
    return (ix1 - ix0) * (iy1 - iy0)


# --------------------------------------------------------------------------- #
# colour rules for the "color" strategy
# --------------------------------------------------------------------------- #
def _rgb(p):
    return p[0], p[1], p[2]


def rule_gold(px):
    """Bright/rim gold of the $ coin; excludes brown hair (g-b<=22)."""
    r, g, b, a = px
    return a > 0 and (r - b) > 35 and (g - b) > 22 and r > 100


def rule_neon(px):
    """Neon-blue sign: blue strokes or near-white glyph fill."""
    r, g, b, a = px
    if a == 0:
        return False
    blue = (b - r) > 25 and b > 110 and (b - g) > 8
    white = r > 230 and g > 230 and b > 230
    return blue or white


def rule_pale(px):
    """Pale-yellow calendar body; excludes skin (skin g<=210)."""
    r, g, b, a = px
    return a > 0 and r > 195 and g > 205 and (r - b) > 12 and (g - b) > 12


def rule_green(px):
    """Genesis goo: green dominant (includes the darker shaded drip tail)."""
    r, g, b, a = px
    return a > 0 and g > r + 18 and g > b + 18 and g > 45


COLOR_RULES = {"gold": rule_gold, "neon": rule_neon, "pale": rule_pale, "green": rule_green}


def filter_house(px):
    """House-opens: cream body OR orange roof/windows; excludes skin/hair."""
    r, g, b, a = px
    if a == 0:
        return False
    cream = r > 235 and g > 235 and b > 205
    orange = r > 150 and g < 150 and b < 120 and (r - b) > 60
    return cream or orange


COLOR_FILTERS = {"house": filter_house}


def color_mask(img, rule_name):
    fn = COLOR_RULES[rule_name]
    w, h = img.size
    px = img.load()
    return [[fn(px[x, y]) for x in range(w)] for y in range(h)]


# --------------------------------------------------------------------------- #
# component-mode core (numpy-accelerated if available)
# --------------------------------------------------------------------------- #
def build_raw_mask(spec, img, master_img):
    """Raw element mask for one art (list-of-rows of bool). numpy if available."""
    strat = spec.get("strategy", "diff")
    if strat == "color":
        return color_mask(img, spec["color"])
    cf = spec.get("color_filter")
    if _has_numpy():
        import numpy as np
        a = np.asarray(img, dtype=np.int16)
        m = np.asarray(master_img, dtype=np.int16)
        d = np.abs(a - m)
        raw = (d[..., :3].sum(2) > DIFF_RGB_THRESHOLD) | (np.abs(d[..., 3]) > DIFF_ALPHA_THRESHOLD)
        if cf:
            fn = COLOR_FILTERS[cf]
            flat = [fn(tuple(int(v) for v in p)) for p in a.reshape(-1, 4).tolist()]
            fm = np.array(flat, bool).reshape(a.shape[0], a.shape[1])
            raw = raw & fm
        return [[bool(v) for v in row] for row in raw]
    mask = diff_mask(img, master_img)
    if cf:
        fn = COLOR_FILTERS[cf]
        px = img.load()
        w, h = img.size
        for y in range(h):
            for x in range(w):
                if mask[y][x] and not fn(px[x, y]):
                    mask[y][x] = False
    return mask


def _component(slug, spec, src_path, master_img):
    img = load_rgba(src_path)
    mask = build_raw_mask(spec, img, master_img)
    return _finalize(slug, spec, img, mask)


def _finalize(slug, spec, img, mask):
    seed = spec["seed"]
    min_size = spec.get("min_size", 8)

    for _ in range(int(spec.get("close", 0))):
        mask = clean_mask(dilate1(mask), 1)

    mask = clean_mask(mask, MORPH_MIN_NEIGHBORS)
    comps = components(mask)
    sel = [c for c in comps if c["size"] >= min_size and _overlap(c["bbox"], seed) > 0]
    if not sel:
        return None, {"slug": slug, "error": "no component overlapped seed with size>=%d" % min_size}

    union = [[False] * len(mask[0]) for _ in range(len(mask))]
    for c in sel:
        for (x, y) in c["pix"]:
            union[y][x] = True
    if spec.get("fill_holes"):
        union = fill_holes(union)

    ys = [y for y in range(len(union)) for x in range(len(union[0])) if union[y][x]]
    xs = [x for y in range(len(union)) for x in range(len(union[0])) if union[y][x]]
    bx0, by0, bx1, by1 = min(xs), min(ys), max(xs) + 1, max(ys) + 1

    alpha = dilate1(union)
    chip = img.crop((bx0, by0, bx1, by1))
    cp = chip.load()
    for y in range(by0, by1):
        for x in range(bx0, bx1):
            r, g, b, _ = cp[x - bx0, y - by0]
            cp[x - bx0, y - by0] = (r, g, b, 255 if alpha[y][x] else 0)

    comp_px = sum(c["size"] for c in sel)
    opaque_px = sum(1 for y in range(by0, by1) for x in range(bx0, bx1) if alpha[y][x])
    area = (bx1 - bx0) * (by1 - by0)
    meta = {
        "slug": slug, "strategy": spec.get("strategy", "diff"),
        "box": {"x0": bx0, "y0": by0, "x1": bx1, "y1": by1},
        "size": [bx1 - bx0, by1 - by0],
        "seed": seed, "components": [c["bbox"] for c in sel],
        "component_px": comp_px, "opaque_px": opaque_px, "area": area,
        "contamination": round(1 - comp_px / opaque_px, 4) if opaque_px else 1.0,
        "occupancy": round(comp_px / area, 4) if area else 0.0,
    }
    return chip, meta


# --------------------------------------------------------------------------- #
# rect mode
# --------------------------------------------------------------------------- #
def run_rect(args, coords):
    from PIL import Image
    srcs = source_map(args.source)
    if not srcs:
        print(f"[legendary-chips] ERROR: no source PNGs in {args.source}", file=sys.stderr)
        return 1
    if not args.dry_run and not os.path.isdir(args.out):
        os.makedirs(args.out, exist_ok=True)
    done, skipped, errors = [], [], []
    for raw_slug, box in coords.items():
        slug = raw_slug.lower().replace(" ", "-")
        if box is None:
            skipped.append((slug, "null -> skipped"))
            continue
        if not valid_box(box):
            errors.append((slug, f"invalid box {box!r}"))
            continue
        if slug not in srcs:
            errors.append((slug, "no matching source PNG"))
            continue
        src = srcs[slug]
        x0, y0, x1, y1 = box["x0"], box["y0"], box["x1"], box["y1"]
        dst = os.path.join(args.out, f"{slug}.png")
        w, h = x1 - x0, y1 - y0
        if args.dry_run:
            print(f"  DRY  {slug:20s} {os.path.basename(src):22s} "
                  f"({x0},{y0})-({x1},{y1}) {w}x{h} -> {dst}")
            done.append(slug)
            continue
        with Image.open(src) as im:
            im = im.convert("RGBA")
            if im.size != (CANVAS, CANVAS):
                errors.append((slug, f"source is {im.size}, expected {CANVAS}x{CANVAS}"))
                continue
            chip = im.crop((x0, y0, x1, y1))
            chip.save(dst, "PNG")
        print(f"  OK   {slug:20s} {w}x{h} -> {dst}")
        done.append(slug)
    print(f"[legendary-chips] {'DRY-RUN ' if args.dry_run else ''}"
          f"extracted={len(done)} skipped={len(skipped)} errors={len(errors)}")
    for s, r in skipped:
        print(f"  skip {s}: {r}")
    for s, r in errors:
        print(f"  ERR  {s}: {r}", file=sys.stderr)
    return 1 if errors else 0


# --------------------------------------------------------------------------- #
# component mode
# --------------------------------------------------------------------------- #
def run_component(args):
    from PIL import Image
    spec = dict(COMPONENT_SPEC)
    if args.spec:
        with open(args.spec, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    if args.only:
        spec = {k: v for k, v in spec.items() if k in set(args.only)}

    master_img = load_rgba(MASTER) if os.path.exists(MASTER) else None
    if not args.dry_run and not os.path.isdir(args.out):
        os.makedirs(args.out, exist_ok=True)

    used = {}
    ok = err = 0
    for slug, s in spec.items():
        src = os.path.join(args.source, s["source"])
        if not os.path.exists(src):
            print(f"  ERR  {slug}: missing source {src}", file=sys.stderr)
            err += 1
            continue
        if s.get("strategy", "diff") == "diff" and master_img is None:
            print(f"  ERR  {slug}: diff strategy needs {MASTER}", file=sys.stderr)
            err += 1
            continue
        chip, meta = _component(slug, s, src, master_img)
        if chip is None:
            print(f"  ERR  {slug}: {meta['error']}", file=sys.stderr)
            err += 1
            continue
        used[slug] = meta["box"]
        b = meta["box"]
        if args.dry_run:
            print(f"  DRY  {slug:20s} {meta['strategy']:5s} "
                  f"({b['x0']},{b['y0']})-({b['x1']},{b['y1']}) "
                  f"{meta['size'][0]}x{meta['size'][1]} comp_px={meta['component_px']} "
                  f"contam={meta['contamination']}")
            ok += 1
            continue
        dst = os.path.join(args.out, f"{slug}.png")
        chip.save(dst, "PNG")
        print(f"  OK   {slug:20s} {meta['strategy']:5s} "
              f"({b['x0']},{b['y0']})-({b['x1']},{b['y1']}) "
              f"{meta['size'][0]}x{meta['size'][1]} comp_px={meta['component_px']} "
              f"contam={meta['contamination']} -> {dst}")
        ok += 1

    if used and args.write_coords and not args.dry_run:
        # W4 schema: {slug: {x0,y0,x1,y1}} — the *used* tight boxes.
        path = args.coords
        merged = {}
        if os.path.exists(path):
            try:
                merged = json.load(open(path, encoding="utf-8"))
                if not isinstance(merged, dict):
                    merged = {}
            except Exception:
                merged = {}
        for slug, b in used.items():
            merged[slug] = {"x0": b["x0"], "y0": b["y0"], "x1": b["x1"], "y1": b["y1"]}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, indent=1, sort_keys=True)
            fh.write("\n")
        print(f"[legendary-chips] coords.json updated: {path} ({len(used)} boxes)")

    print(f"[legendary-chips] {'DRY-RUN ' if args.dry_run else ''}"
          f"component extracted={ok} errors={err}")
    return 1 if err else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract Legendary emblem chips")
    ap.add_argument("--mode", choices=("rect", "component"), default="rect")
    ap.add_argument("--coords", default=COORDS, help="path to coords.json")
    ap.add_argument("--out", default=OUT_DIR, help="output directory for chips")
    ap.add_argument("--dry-run", action="store_true", help="plan only; write nothing")
    ap.add_argument("--source", default=LEG_DIR, help="source dir (overrides for testing)")
    ap.add_argument("--spec", default=None, help="component-mode spec JSON (defaults to embedded)")
    ap.add_argument("--only", nargs="*", default=None, help="component mode: subset of slugs")
    ap.add_argument("--write-coords", dest="write_coords", action="store_true", default=True)
    ap.add_argument("--no-write-coords", dest="write_coords", action="store_false")
    args = ap.parse_args()

    try:
        import PIL  # noqa: F401
    except ImportError:
        print("[legendary-chips] ERROR: Pillow missing. pip install --user pillow", file=sys.stderr)
        return 1

    if args.mode == "component":
        return run_component(args)

    # ---- rect mode (legacy) ----
    if not os.path.exists(args.coords):
        print(f"[legendary-chips] coords.json not found: {args.coords}")
        print("  -> nothing to do. Create it with the schema documented in this file.")
        return 0
    try:
        with open(args.coords, "r", encoding="utf-8") as fh:
            coords = json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[legendary-chips] ERROR: cannot read/parse {args.coords}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(coords, dict) or not coords:
        print("[legendary-chips] coords.json is empty -> nothing to extract.")
        print("  Fill it, e.g.:")
        print('    {"Sept 16": {"x0":84,"y0":2,"x1":124,"y1":42}}')
        return 0
    return run_rect(args, coords)


if __name__ == "__main__":
    raise SystemExit(main())
