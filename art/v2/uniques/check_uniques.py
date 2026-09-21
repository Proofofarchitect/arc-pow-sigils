#!/usr/bin/env python3
"""check_uniques.py — integrity gate for arc-uniques/1 (assets, copies, seal).

Checks (exit 1 on any FAIL):
  A. registry: 18 pieces, codes P01–P18 unique, slugs/names unique, sha256 valid
  B. canon assets: art/v2/uniques/<slug>.png — exist, 1254×1254, sha matches
  C. copies: web/ + domain_fork/ public PNGs byte-equal; lib registries identical
  D. seal (when ops/uniques/ids.local.json exists): 18 ids, one per window,
     commitment matches ops/uniques/COMMITMENT.txt; env files carry the same list
  E. leak guard: secret files not tracked by git (best effort via `git check-ignore`)

Run from the repo root:
  python3 art/v2/uniques/check_uniques.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))

import gen_ids  # noqa: E402

OUT = REPO / "art" / "v2" / "uniques"
REGISTRY = OUT / "registry.json"
SECRET = REPO / "ops" / "uniques" / "ids.local.json"
COMMITMENT = REPO / "ops" / "uniques" / "COMMITMENT.txt"
COPIES = [
    (REPO / "web" / "public" / "uniques", REPO / "web" / "lib" / "uniques-registry.json"),
    (REPO / "domain_fork" / "public" / "uniques", REPO / "domain_fork" / "lib" / "uniques-registry.json"),
]
ENV_FILES = [REPO / "web" / ".env.local", REPO / "domain_fork" / ".env.local"]

fails: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        fails.append(label)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    from PIL import Image  # noqa: PLC0415

    registry = json.loads(REGISTRY.read_text())
    pieces = registry["pieces"]

    print("A. registry")
    check(registry["domain"] == "arc-uniques/1", "domain == arc-uniques/1")
    check(len(pieces) == 18, f"18 pieces (got {len(pieces)})")
    check([p["code"] for p in pieces] == [f"P{i:02d}" for i in range(1, 19)], "codes P01..P18 in order")
    check(len({p["slug"] for p in pieces}) == 18, "slugs unique")
    check(len({p["name"] for p in pieces}) == 18, "names unique")

    print("B. canon assets")
    for p in pieces:
        f = OUT / p["file"]
        ok = f.exists() and sha256(f) == p["sha256"]
        size_ok = f.exists() and tuple(Image.open(f).size) == (1254, 1254)
        check(ok and size_ok, f"{p['file']} sha+canvas")

    print("C. copies")
    reg_text = REGISTRY.read_text()
    for pub_dir, reg_copy in COPIES:
        rel = pub_dir.relative_to(REPO)
        check(reg_copy.exists() and reg_copy.read_text() == reg_text, f"{rel.parent.name}/lib registry identical")
        for p in pieces:
            src, tgt = OUT / p["file"], pub_dir / p["file"]
            check(tgt.exists() and src.read_bytes() == tgt.read_bytes(), f"{rel}/{p['file']} bytes equal")

    print("D. seal")
    if not SECRET.exists():
        print("  (no sealed ids yet — skipped)")
    else:
        data = json.loads(SECRET.read_text())
        probs = gen_ids.check_shape(data["ids"], len(pieces), gen_ids.SUPPLY)
        check(not probs, f"shape ok ({probs})" if probs else "18 ids, one per window, in range")
        got = gen_ids.commitment_of(data["ids"], data["salt"])
        published = [l for l in COMMITMENT.read_text().splitlines() if l.startswith("commitment:")]
        check(bool(published) and published[0].split(":", 1)[1].strip() == got, "commitment matches published")
        expected_env = ",".join(str(i) for i in data["ids"])
        for env in ENV_FILES:
            text = env.read_text() if env.exists() else ""
            val = next((l.split("=", 1)[1] for l in text.splitlines() if l.startswith("UNIQUES_IDS=")), "")
            check(val == expected_env, f"{env.name} UNIQUES_IDS == sealed list")

    print("E. leak guard")
    for rel, should_be_ignored in [
        ("ops/uniques/ids.local.json", True),
        ("ops/uniques/COMMITMENT.txt", False),
    ]:
        r = subprocess.run(["git", "-C", str(REPO), "check-ignore", rel], capture_output=True, text=True)
        ignored = r.returncode == 0
        label = "gitignored" if should_be_ignored else "trackable (public anchor)"
        check(ignored == should_be_ignored, f"{rel} {label}")

    print()
    if fails:
        print(f"FAIL — {len(fails)} check(s)")
        return 1
    print("PASS — all uniques checks green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
