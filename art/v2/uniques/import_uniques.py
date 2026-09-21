#!/usr/bin/env python3
"""import_uniques.py — rare uniques (P01–P18) → canon + public web copies.

Source : art/arc-traits/handoff-2026-09-20/rare-concepts/concepts/P01.png … P18.png
         (1254x1254 RGB, artist draft PNGs — approval: owner, 2026-09-20).

Outputs (canonical then copies, idempotent):
  art/v2/uniques/<slug>.png                 canonical assets
  art/v2/uniques/registry.json              public piece registry (18 pieces)
  web/public/uniques/<slug>.png             + web/lib/uniques-registry.json
  domain_fork/public/uniques/<slug>.png     + domain_fork/lib/uniques-registry.json

Mechanic (see art/v2/uniques/README.md):
  18 pieces, exactly one copy each, assigned to HIDDEN token ids (sealed list,
  commit-reveal). Rendering resolves id → piece only server-side (`UNIQUES_IDS`).

CLI:
  python3 art/v2/uniques/import_uniques.py            # check (report)
  python3 art/v2/uniques/import_uniques.py --write    # copy + registry
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "art" / "arc-traits" / "handoff-2026-09-20" / "rare-concepts" / "concepts"
OUT = REPO / "art" / "v2" / "uniques"
REGISTRY = OUT / "registry.json"

WEB = REPO / "web"
FORK = REPO / "domain_fork"
COPIES = [
    (WEB / "public" / "uniques", WEB / "lib" / "uniques-registry.json"),
    (FORK / "public" / "uniques", FORK / "lib" / "uniques-registry.json"),
]

# code -> (slug, name, category); names are DRAFT — owner approves before reveal.
PIECES: list[tuple[str, str, str, str]] = [
    ("P01", "p01-visionary", "The Visionary", "People"),
    ("P02", "p02-builder", "The Builder", "People"),
    ("P03", "p03-analyst", "The Analyst", "People"),
    ("P04", "p04-thinker", "The Thinker", "People"),
    ("P05", "p05-operator", "The Operator", "People"),
    ("P06", "p06-dreamer", "The Dreamer", "People"),
    ("P07", "p07-mentor", "The Mentor", "People"),
    ("P08", "p08-diplomat", "The Diplomat", "People"),
    ("P09", "p09-principal", "The Principal", "People"),
    ("P10", "p10-optimist", "The Optimist", "People"),
    ("P11", "p11-satoshi", "Satoshi", "Mythic"),
    ("P12", "p12-specter", "Specter", "Mythic"),
    ("P13", "p13-zombie", "Zombie", "Mythic"),
    ("P14", "p14-phantom", "Phantom", "Mythic"),
    ("P15", "p15-black-cat", "Black Cat", "Mythic"),
    ("P16", "p16-unicorn", "Unicorn", "Mythic"),
    ("P17", "p17-cosmic", "Cosmic Entity", "Mythic"),
    ("P18", "p18-cipherpunk", "Cipherpunk", "Mythic"),
]
EXPECTED_CANVAS = (1254, 1254)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_registry(write: bool) -> tuple[dict, list[str]]:
    problems: list[str] = []
    pieces = []
    for code, slug, name, category in PIECES:
        src = SRC / f"{code}.png"
        if not src.exists():
            problems.append(f"missing source: {src}")
            continue

        from PIL import Image  # noqa: PLC0415

        img = Image.open(src)
        if tuple(img.size) != EXPECTED_CANVAS:
            problems.append(f"{code}: canvas {img.size} != {EXPECTED_CANVAS}")

        target = OUT / f"{slug}.png"
        if write:
            target.write_bytes(src.read_bytes())
        pieces.append(
            {
                "code": code,
                "slug": slug,
                "name": name,
                "category": category,
                "file": f"{slug}.png",
                "sha256": sha256(src),
                "canvas": list(EXPECTED_CANVAS),
            }
        )

    registry = {
        "domain": "arc-uniques/1",
        "created": "2026-09-20",
        "note": "18 one-of-one whole-scene pieces, exactly one copy each, hidden token ids (commit-reveal). Names are DRAFT pending owner approval.",
        "source": "arc-gold-rare-v2-2026-09-20 / rare-concepts/concepts (handoff-2026-09-20)",
        "max_supply": 15042,
        "pieces": pieces,
    }
    return registry, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    registry, problems = build_registry(args.write)
    if len(registry["pieces"]) != len(PIECES):
        problems.append(f"pieces {len(registry['pieces'])} != {len(PIECES)}")

    if args.write:
        OUT.mkdir(parents=True, exist_ok=True)
        REGISTRY.write_text(json.dumps(registry, indent=1) + "\n")
        for pub_dir, reg_copy in COPIES:
            pub_dir.mkdir(parents=True, exist_ok=True)
            for piece in registry["pieces"]:
                (pub_dir / piece["file"]).write_bytes((OUT / piece["file"]).read_bytes())
            reg_copy.write_text(json.dumps(registry, indent=1) + "\n")
        print(f"written: {len(registry['pieces'])} png -> {OUT.relative_to(REPO)}")
        print(f"         registry -> {REGISTRY.relative_to(REPO)} (+ {len(COPIES)} copies)")
    else:
        print(f"(check) {len(registry['pieces'])} pieces; run with --write to import")

    if problems:
        print(f"PROBLEMS: {len(problems)}")
        for p in problems[:10]:
            print("  -", p)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
