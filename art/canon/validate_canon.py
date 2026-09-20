#!/usr/bin/env python3
"""validate_canon.py — standalone validator for the House Card "canon" pixel-art system.

Reads art/canon/ANCHORS.json and validates the layer catalog, its SVG encodings,
the canon masks and the recomposed cards against that schema.

Gates
-----
  G1 canvas+alpha   layers_png + masks + master: RGBA/L 128x128; layer alpha in {0,255}
  G2 svg fidelity   rasterize layers_svg, compare pixel-exact to layers_png
  G3 palette        unique RGB (alpha>0) per layer vs card/scene color caps
  G4 containment    layer pixels inside ANCHORS region AND mask / inside zone
  G5 card recompose stack layer PNGs per zorder vs cards/card_NN_png.png
  G6 spec cross-ref art/spec.json slots vs ANCHORS slots (warnings only)
  G7 bounds         regions/zones within 0..128; sprite zones must not overlap

Output: compact gate table, art/canon/reports/validate_report.json, exit 1 on any FAIL.

Usage:
  python3 art/canon/validate_canon.py [--root REPO_ROOT]

stdlib + Pillow only (no numpy).
"""
import argparse
import glob
import json
import os
import sys
import time
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

CANVAS = 128
PASS, FAIL, WARN = "PASS", "FAIL", "WARN"
SPRITE_SLOTS_DEFAULT = ("tool", "companion", "bug")


# --------------------------------------------------------------------------- io / helpers
def find_root(start):
    """Walk up from `start` until a directory containing `art/` is found."""
    p = os.path.abspath(start)
    while True:
        if os.path.isdir(os.path.join(p, "art")):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent


def load_rgba(path):
    return Image.open(path).convert("RGBA")


def pixel_diff(im1, im2):
    """Count differing pixels (RGBA). Returns -1 on size mismatch."""
    if im1.size != im2.size:
        return -1
    a, b = im1.load(), im2.load()
    w, h = im1.size
    n = 0
    for y in range(h):
        for x in range(w):
            if a[x, y] != b[x, y]:
                n += 1
    return n


def alpha_pixels(img):
    """List of (x,y) where alpha>0."""
    px = img.load()
    w, h = img.size
    return [(x, y) for y in range(h) for x in range(w) if px[x, y][3] > 0]


def slot_of(fname):
    base = os.path.basename(fname)
    if base.endswith(".png"):
        base = base[:-4]
    return base.split("__", 1)[0] if "__" in base else base


def trait_of(fname):
    base = os.path.basename(fname)
    if base.endswith(".png"):
        base = base[:-4]
    return base.split("__", 1)[1] if "__" in base else base


def box_from_dict_or_list(v):
    """Normalize a region/zone to (x0,y0,x1,y1). Accepts dict or 4-list."""
    if v is None:
        return None
    if isinstance(v, dict):
        if all(k in v for k in ("x0", "y0", "x1", "y1")):
            return (v["x0"], v["y0"], v["x1"], v["y1"])
        if all(k in v for k in ("y0", "y1", "x0", "x1")):
            return (v["x0"], v["y0"], v["x1"], v["y1"])
        return None
    if isinstance(v, (list, tuple)) and len(v) == 4:
        return (v[0], v[1], v[2], v[3])
    return None


def inside(box, x, y):
    x0, y0, x1, y1 = box
    return x0 <= x < x1 and y0 <= y < y1


def make_mask_tester(path):
    """Return (fn, mode) where fn(x,y)->bool = pixel is allowed by the mask."""
    img = Image.open(path)
    px = img.load()
    mode = img.mode
    if mode == "L":
        return (lambda x, y: px[x, y] > 127), mode
    return (lambda x, y: px[x, y][3] > 0), mode


# --------------------------------------------------------------------------- gates
def gate_g1(anchors, root, paths):
    g = {"id": "G1", "name": "canvas+alpha", "status": PASS, "metrics": {}, "details": []}
    layers = sorted(glob.glob(os.path.join(paths["layers_png"], "*.png")))
    masks = sorted(glob.glob(os.path.join(paths["masks_dir"], "*.png"))) if paths.get("masks_dir") else []
    master = paths.get("master")

    files = [("layer", p) for p in layers] + [("mask", p) for p in masks]
    if master and os.path.exists(master):
        files.append(("master", master))

    bad_dim, bad_alpha = [], []
    for kind, p in files:
        im = Image.open(p)
        if im.size != (CANVAS, CANVAS) or im.mode not in ("RGBA", "L"):
            bad_dim.append(f"{os.path.basename(p)} ({im.mode} {im.size[0]}x{im.size[1]})")
        if kind == "layer":
            rgba = im.convert("RGBA")
            px = rgba.load()
            bad = sorted({px[x, y][3] for y in range(CANVAS) for x in range(CANVAS)} - {0, 255})
            if bad:
                bad_alpha.append(f"{os.path.basename(p)} nonstd_alpha={bad[:5]}")

    g["metrics"] = {
        "layers_checked": len(layers),
        "masks_checked": len(masks),
        "master_present": bool(master and os.path.exists(master)),
        "bad_dim_or_mode": len(bad_dim),
        "bad_alpha": len(bad_alpha),
    }
    if bad_dim or bad_alpha:
        g["status"] = FAIL
        g["details"] = bad_dim + bad_alpha
    return g


def rasterize_svg(path):
    """Rasterize our rect-run SVG encoding to an RGBA 128x128 image."""
    tree = ET.parse(path)
    root = tree.getroot()
    w = int(round(float(root.get("width", CANVAS))))
    h = int(round(float(root.get("height", CANVAS))))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for rect in root.iter():
        if not rect.tag.endswith("rect"):
            continue
        x = int(round(float(rect.get("x", 0))))
        y = int(round(float(rect.get("y", 0))))
        rw = int(round(float(rect.get("width", 0))))
        rh = int(round(float(rect.get("height", 0))))
        fill = rect.get("fill")
        if not fill or not fill.startswith("#"):
            continue
        hx = fill[1:]
        if len(hx) == 3:
            hx = "".join(c * 2 for c in hx)
        if len(hx) != 6:
            continue
        r, gg, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
        op = float(rect.get("fill-opacity", 1.0))
        a = int(round(255 * op))
        img.paste((r, gg, b, a), (x, y, x + rw, y + rh))
    return img


def gate_g2(anchors, root, paths):
    g = {"id": "G2", "name": "svg fidelity", "status": PASS, "metrics": {}, "details": []}
    svgs = sorted(glob.glob(os.path.join(paths["layers_svg"], "*.svg")))
    total_rects = 0
    offenders, missing = [], []
    for svg in svgs:
        base = os.path.basename(svg)[:-4]
        png = os.path.join(paths["layers_png"], base + ".png")
        if not os.path.exists(png):
            missing.append(base)
            continue
        try:
            rast = rasterize_svg(svg).convert("RGBA")
        except Exception as e:  # noqa: BLE001
            offenders.append(f"{base}: parse-error {e}")
            continue
        # count rects for reporting
        try:
            total_rects += sum(1 for _ in ET.parse(svg).getroot().iter())
        except Exception:  # noqa: BLE001
            pass
        ref = load_rgba(png)
        d = pixel_diff(rast, ref)
        if d != 0:
            offenders.append(f"{base}: diff={d}px")
    g["metrics"] = {
        "svgs_checked": len(svgs),
        "missing_png": len(missing),
        "diff_offenders": len(offenders),
        "total_svg_nodes": total_rects,
    }
    if offenders or missing:
        g["status"] = FAIL
        g["details"] = (missing and [f"missing png: {m}" for m in missing] or []) + offenders
    return g


def gate_g3(anchors, root, paths):
    g = {"id": "G3", "name": "palette", "status": PASS, "metrics": {}, "details": []}
    pol = anchors.get("palette_policy", {}) or {}
    card_max = int(pol.get("card_max_colors", 64))
    scene_max = int(pol.get("scene_max_colors", 112))
    slots = anchors.get("slots", {}) or {}

    def is_scene(slot):
        spec = slots.get(slot, {}) or {}
        return bool(spec.get("native_256_allowed")) or slot == "background"

    rows = []
    for png in sorted(glob.glob(os.path.join(paths["layers_png"], "*.png"))):
        slot = slot_of(png)
        rgba = load_rgba(png)
        px = rgba.load()
        colors = {(px[x, y][0], px[x, y][1], px[x, y][2])
                  for y in range(CANVAS) for x in range(CANVAS) if px[x, y][3] > 0}
        limit = scene_max if is_scene(slot) else card_max
        rows.append((os.path.basename(png), slot, len(colors), limit))

    offenders = sorted([r for r in rows if r[2] > r[3]], key=lambda r: -r[2])
    g["metrics"] = {
        "layers_checked": len(rows),
        "card_max_colors": card_max,
        "scene_max_colors": scene_max,
        "max_colors": max([r[2] for r in rows], default=0),
        "offenders": len(offenders),
    }
    if offenders:
        g["status"] = FAIL
        g["details"] = [f"{n}: {c} colors > {lim} (slot={slot})" for (n, slot, c, lim) in offenders]
    return g


def gate_g4(anchors, root, paths):
    g = {"id": "G4", "name": "containment", "status": PASS, "metrics": {}, "details": []}
    slots = anchors.get("slots", {}) or {}
    offenders = []
    checked = 0
    exempt = 0

    for png in sorted(glob.glob(os.path.join(paths["layers_png"], "*.png"))):
        slot = slot_of(png)
        spec = slots.get(slot)
        if not spec:
            offenders.append(f"{os.path.basename(png)}: slot '{slot}' not in ANCHORS.slots")
            continue
        kind = spec.get("kind")
        img = load_rgba(png)
        coords = alpha_pixels(img)

        # legendary layers_png are legacy full-canvas full-art (1:1 overlay) -> exempt.
        # Their replacement (emblem chips) is validated below from legendary_chips/*.png.
        if kind == "full" or slot == "legendary":
            exempt += 1
            continue

        checked += 1
        if kind in ("masked", "sparse"):
            mask_paths = []
            if spec.get("mask"):
                mask_paths.append(os.path.join(root, spec["mask"]))
            if spec.get("back_mask"):
                mask_paths.append(os.path.join(root, spec["back_mask"]))
            testers = []
            for mp in mask_paths:
                if os.path.exists(mp):
                    fn, _ = make_mask_tester(mp)
                    testers.append(fn)
            if testers:
                bad = [c for c in coords if not any(t(*c) for t in testers)]
                if bad:
                    offenders.append(f"{os.path.basename(png)}: {len(bad)}px outside mask "
                                     f"({', '.join(os.path.basename(m) for m in mask_paths)})")
        elif kind == "patch":
            box = box_from_dict_or_list(spec.get("region"))
            outside_region = [c for c in coords if box and not inside(box, *c)]
            outside_mask = []
            if spec.get("mask"):
                mp = os.path.join(root, spec["mask"])
                if os.path.exists(mp):
                    fn, _ = make_mask_tester(mp)
                    outside_mask = [c for c in coords if not fn(*c)]
            msgs = []
            if outside_region:
                msgs.append(f"{len(outside_region)}px outside region {box}")
            if outside_mask:
                msgs.append(f"{len(outside_mask)}px outside mask {os.path.basename(spec['mask'])}")
            if msgs:
                offenders.append(f"{os.path.basename(png)}: " + "; ".join(msgs))
        elif kind in ("sprite", "chip"):
            zone = box_from_dict_or_list(spec.get("zone"))
            bb = img.getbbox()
            if zone and bb:
                l, t, r, b = bb
                if not (zone[0] <= l and t >= zone[1] and r <= zone[2] and b <= zone[3]):
                    offenders.append(f"{os.path.basename(png)}: bbox {bb} outside zone {zone}")
        else:
            offenders.append(f"{os.path.basename(png)}: unknown kind '{kind}'")

    # legendary chips (only if top-level *.png exist)
    chips_dir = paths.get("legendary_chips")
    chip_files = sorted(glob.glob(os.path.join(chips_dir, "*.png"))) if chips_dir else []
    chip_offenders = []
    if chip_files:
        lspec = slots.get("legendary", {}) or {}
        zone = box_from_dict_or_list(lspec.get("zone"))
        for cf in chip_files:
            im = load_rgba(cf)
            bb = im.getbbox()
            if zone and bb:
                l, t, r, b = bb
                if (l, t) == (0, 0):
                    # crop-форма: чип вырезан от origin (0,0) и на карте прижимается
                    # к правому верхнему углу поля чипа -> проверяем габариты по полю.
                    cw, ch = r - l, b - t
                    zw, zh = zone[2] - zone[0], zone[3] - zone[1]
                    if cw > zw or ch > zh:
                        chip_offenders.append(
                            f"{os.path.basename(cf)}: crop {cw}x{ch} > chip field {zw}x{zh}")
                elif not (zone[0] <= l and t >= zone[1] and r <= zone[2] and b <= zone[3]):
                    chip_offenders.append(f"{os.path.basename(cf)}: bbox {bb} outside chip zone {zone}")
    g["metrics"] = {
        "layers_total": len(glob.glob(os.path.join(paths["layers_png"], "*.png"))),
        "checked": checked,
        "exempt_full": exempt,
        "legendary_chips_checked": len(chip_files),
        "offenders": len(offenders) + len(chip_offenders),
    }
    all_off = offenders + chip_offenders
    if all_off:
        g["status"] = FAIL
        g["details"] = all_off
    return g


def gate_g5(anchors, root, paths):
    g = {"id": "G5", "name": "card recompose", "status": PASS, "metrics": {}, "details": []}
    cards_dir = paths["cards"]
    man_path = os.path.join(cards_dir, "manifest.json")
    if not os.path.exists(man_path):
        g["status"] = FAIL
        g["details"] = [f"manifest not found: {man_path}"]
        return g
    manifest = json.load(open(man_path))

    zorder = anchors.get("zorder", [])
    rules = anchors.get("rules", {}) or {}
    null_traits = set(rules.get("null_traits", []))
    supp = rules.get("face_eyes_suppress", {}) or {}
    suppress_faces = set(supp.get("faces", []))
    suppressed_layer = supp.get("suppressed_layer", "eyes")

    offenders, mismatches = [], []
    body_offsets = {k: tuple(v) for k, v in (anchors.get("slots", {}).get("body", {}).get("offsets", {}) or {}).items()}
    no_shift = {"background", "legendary"}
    for c in manifest:
        idx = int(c.get("idx"))
        stack = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        body_off = body_offsets.get(c.get("body"))
        for slot in zorder:
            if slot not in c:
                continue
            tid = c[slot]
            if tid in null_traits:
                continue
            if slot == suppressed_layer and c.get("face") in suppress_faces:
                continue
            lp = os.path.join(paths["layers_png"], f"{slot}__{tid}__{c.get('body')}.png")
            if not os.path.exists(lp):
                if slot in ("eyes", "face", "headwear"):
                    lp = None  # голова: только per-body, легаси не подставляем
                else:
                    lp = os.path.join(paths["layers_png"], f"{slot}__{tid}.png")
            if lp is None or not os.path.exists(lp):
                if slot in ("eyes", "face", "headwear"):
                    continue  # per-body слой для этого тела не предусмотрен (напр. лицо только для guy)
                mismatches.append(f"card_{idx:02d}: missing layer {slot}__{tid}")
                continue
            lrgba = load_rgba(lp)
            if body_off and slot not in no_shift:
                tmp = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
                tmp.alpha_composite(lrgba, dest=(body_off[0], body_off[1]))
                lrgba = tmp
            stack.alpha_composite(lrgba)
        ref_path = os.path.join(cards_dir, f"card_{idx:02d}_png.png")
        if not os.path.exists(ref_path):
            mismatches.append(f"card_{idx:02d}: reference png missing")
            continue
        d = pixel_diff(stack, load_rgba(ref_path))
        if d != 0:
            offenders.append(f"card_{idx:02d}: diff={d}px")
        # cross-check manifest suppression flag
        expect_sup = c.get("face") in suppress_faces
        if "eyes_suppressed" in c and bool(c["eyes_suppressed"]) != expect_sup:
            mismatches.append(f"card_{idx:02d}: eyes_suppressed flag inconsistent")

    g["metrics"] = {
        "cards_checked": len(manifest),
        "diff_offenders": len(offenders),
        "flag_mismatches": len(mismatches),
    }
    if offenders or mismatches:
        g["status"] = FAIL
        g["details"] = offenders + mismatches
    return g


def gate_g6(anchors, root, paths):
    g = {"id": "G6", "name": "spec cross-ref", "status": WARN, "metrics": {}, "details": []}
    spec_path = os.path.join(root, "art", "spec.json")
    if not os.path.exists(spec_path):
        g["status"] = WARN
        g["details"] = [f"spec not found: {spec_path}"]
        return g

    def norm(s):
        return s.strip().lower().replace("_", "-").replace(" ", "-")

    spec = json.load(open(spec_path))
    spec_slots = {norm(s["name"]): s for s in spec.get("slots", [])}
    anchor_slots = {norm(k): k for k in (anchors.get("slots", {}) or {})}
    # top-level 'golden' behaves like a slot in the spec
    if "golden" in anchors:
        anchor_slots.setdefault("golden", "golden")

    rules = anchors.get("rules", {}) or {}
    service_slots = {norm(s) for s in rules.get("g6_service_slots", [])}
    metadata_slots = {norm(s) for s in rules.get("g6_metadata_slots", [])}

    warnings = []
    for name in sorted(spec_slots):
        if name not in anchor_slots and name not in metadata_slots:
            s = spec_slots[name]
            warnings.append(f"spec slot '{s['name']}' (render={s.get('render')}) absent from ANCHORS.slots")
    for name in sorted(set(anchor_slots) - set(spec_slots)):
        if name in service_slots:
            continue
        warnings.append(f"ANCHORS slot '{anchor_slots[name]}' absent from spec.json")

    # value-level cross-ref where ANCHORS carries value lists
    value_notes = []
    for name, s in spec_slots.items():
        aspec = anchors.get("slots", {}).get(anchor_slots.get(name, ""), {}) or {}
        av = aspec.get("values")
        if av:
            spec_vals = {norm(v["name"]) for v in s.get("values", [])}
            anch_vals = {norm(v if isinstance(v, str) else v.get("name", "")) for v in av}
            for alias in (aspec.get("value_aliases") or {}):
                anch_vals.add(norm(alias))
            for miss in sorted(spec_vals - anch_vals):
                value_notes.append(f"{name}: spec value '{miss}' not in ANCHORS values")

    g["metrics"] = {
        "spec_slots": len(spec_slots),
        "anchors_slots": len(anchor_slots),
        "unknown_mappings": len(warnings),
        "value_notes": len(value_notes),
    }
    g["status"] = WARN if (warnings or value_notes) else PASS  # advisory gate
    g["details"] = warnings + value_notes
    if not warnings and not value_notes:
        g["details"] = ["all spec slots mapped to ANCHORS slots"]
    return g


def gate_g7(anchors, root, paths):
    g = {"id": "G7", "name": "bounds", "status": PASS, "metrics": {}, "details": []}
    slots = anchors.get("slots", {}) or {}
    offenders, overlaps = [], []
    checked = 0
    sprite_zones = {}
    for name, spec in slots.items():
        for key in ("region", "zone"):
            box = box_from_dict_or_list(spec.get(key))
            if box is None:
                continue
            checked += 1
            x0, y0, x1, y1 = box
            if not (0 <= x0 < x1 <= CANVAS and 0 <= y0 < y1 <= CANVAS):
                offenders.append(f"{name}.{key}={box} out of 0..{CANVAS}")
        if spec.get("kind") == "sprite":
            box = box_from_dict_or_list(spec.get("zone"))
            if box:
                sprite_zones[name] = box
    # pairwise sprite-zone overlap
    names = sorted(sprite_zones)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = sprite_zones[names[i]], sprite_zones[names[j]]
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                overlaps.append(f"{names[i]} {a} overlaps {names[j]} {b}")
    g["metrics"] = {"boxes_checked": checked, "sprite_zones": len(sprite_zones),
                    "out_of_bounds": len(offenders), "zone_overlaps": len(overlaps)}
    if offenders:
        g["status"] = FAIL
        g["details"] = offenders
    elif overlaps:
        g["status"] = WARN
        g["details"] = overlaps
    return g


# --------------------------------------------------------------------------- main
def resolve_paths(anchors, root):
    p = anchors.get("paths", {}) or {}

    def rp(v, default):
        if not v:
            return os.path.join(root, default)
        return v if os.path.isabs(v) else os.path.join(root, v)

    return {
        "master": rp(p.get("master"), "art/canon/master.png"),
        "layers_png": rp(p.get("layers_png"), "art/svg/catalog/layers_png"),
        "layers_svg": rp(p.get("layers_svg"), "art/svg/catalog/layers_svg"),
        "cards": rp(p.get("cards"), "art/svg/catalog/cards"),
        "legendary_chips": rp(p.get("legendary_chips"), "art/canon/legendary_chips"),
        "masks_dir": os.path.join(root, "art", "canon", "masks"),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="House Card canon validator")
    ap.add_argument("--root", default=None, help="repo root (default: walk up from __file__ to art/)")
    args = ap.parse_args(argv)

    root = args.root or find_root(os.path.dirname(os.path.abspath(__file__)))
    if not root:
        print("ERROR: could not locate repo root (no art/ ancestor). Use --root.", file=sys.stderr)
        return 2

    anchors_path = os.path.join(root, "art", "canon", "ANCHORS.json")
    if not os.path.exists(anchors_path):
        print(f"ERROR: ANCHORS.json not found at {anchors_path}", file=sys.stderr)
        return 2
    anchors = json.load(open(anchors_path))
    paths = resolve_paths(anchors, root)

    gates = [
        gate_g1(anchors, root, paths),
        gate_g2(anchors, root, paths),
        gate_g3(anchors, root, paths),
        gate_g4(anchors, root, paths),
        gate_g5(anchors, root, paths),
        gate_g6(anchors, root, paths),
        gate_g7(anchors, root, paths),
    ]

    # ---- console table
    print(f"validate_canon  root={root}")
    print(f"anchors={os.path.relpath(anchors_path, root)}  schema={anchors.get('schema_version')}")
    print("-" * 78)
    print(f"{'GATE':<4} {'NAME':<16} {'STATUS':<5}  METRICS")
    print("-" * 78)
    for g in gates:
        m = ", ".join(f"{k}={v}" for k, v in g["metrics"].items())
        print(f"{g['id']:<4} {g['name']:<16} {g['status']:<5}  {m}")
    print("-" * 78)

    # ---- details for non-PASS
    for g in gates:
        if g["status"] != PASS and g.get("details"):
            head = "WARN" if g["status"] == WARN else "FAIL"
            print(f"\n[{head}] {g['id']} {g['name']}:")
            for d in g["details"][:40]:
                print(f"   - {d}")
            if len(g["details"]) > 40:
                print(f"   ... +{len(g['details']) - 40} more")

    # ---- warnings section (G6 advisories + non-fatal notes)
    warnings = []
    for g in gates:
        if g["status"] == WARN and g.get("details"):
            warnings += [f"{g['id']}: {d}" for d in g["details"]]

    n_fail = sum(1 for g in gates if g["status"] == FAIL)
    n_warn = sum(1 for g in gates if g["status"] == WARN)
    n_pass = sum(1 for g in gates if g["status"] == PASS)
    exit_code = 1 if n_fail else 0

    print(f"\nSUMMARY  PASS={n_pass}  FAIL={n_fail}  WARN={n_warn}  ->  exit {exit_code}")

    # ---- json report
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "root": root,
        "anchors": os.path.relpath(anchors_path, root),
        "schema_version": anchors.get("schema_version"),
        "gates": gates,
        "warnings": warnings,
        "summary": {"pass": n_pass, "fail": n_fail, "warn": n_warn, "exit_code": exit_code},
        "files": {
            "layers_png": sorted(os.path.basename(p) for p in glob.glob(os.path.join(paths["layers_png"], "*.png"))),
            "layers_svg": sorted(os.path.basename(p) for p in glob.glob(os.path.join(paths["layers_svg"], "*.svg"))),
            "masks": sorted(os.path.basename(p) for p in glob.glob(os.path.join(paths["masks_dir"], "*.png"))) if os.path.isdir(paths["masks_dir"]) else [],
            "cards": sorted(os.path.basename(p) for p in glob.glob(os.path.join(paths["cards"], "card_*_png.png"))),
            "legendary_chips": sorted(os.path.basename(p) for p in glob.glob(os.path.join(paths["legendary_chips"], "*.png"))) if os.path.isdir(paths["legendary_chips"]) else [],
            "master": os.path.basename(paths["master"]),
        },
    }
    reports_dir = os.path.join(root, "art", "canon", "reports")
    os.makedirs(reports_dir, exist_ok=True)
    out = os.path.join(reports_dir, "validate_report.json")
    with open(out, "w") as f:
        json.dump(report, f, indent=2)
    print(f"report -> {os.path.relpath(out, root)}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
