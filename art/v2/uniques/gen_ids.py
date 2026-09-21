#!/usr/bin/env python3
"""gen_ids.py — hidden unique token ids: stratified draw + commit-reveal ceremony.

Mechanic (owner decision 2026-09-20, see art/v2/uniques/README.md):
  18 unique pieces (P01–P18), exactly ONE copy each, bound to hidden token ids.
  One id is drawn per window of the 1..15 042 id space (12 windows of 836 +
  6 windows of 835) so the legends are stratified across the whole emission.
  Piece index = draw order (piece i lives at ids[i]).

Commitment (fairness anchor, published BEFORE mainnet):
  commitment = sha256( canonical_json({"domain":"arc-uniques/1","ids":[...],"salt":"..."}) )
  Published -> ops/uniques/COMMITMENT.txt. After every unique is found (or the
  collection sells out) ids+salt are revealed; anyone re-checks with
  `--check-reveal <ids> <salt>` against the published commitment.

CLI:
  python3 art/v2/uniques/gen_ids.py --write     # draw once + seal + env files
  python3 art/v2/uniques/gen_ids.py --verify    # re-check local seal vs commitment
  python3 art/v2/uniques/gen_ids.py --reveal    # print ids+salt (post-event only)
  python3 art/v2/uniques/gen_ids.py --check-reveal "id0,...,id17" <salt>

Secrets: ops/uniques/ids.local.json (0600, gitignored). Never commit, never print
before the reveal. The renderer only needs the id list via server env UNIQUES_IDS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
REGISTRY = REPO / "art" / "v2" / "uniques" / "registry.json"
SECRET_DIR = REPO / "ops" / "uniques"
SECRET = SECRET_DIR / "ids.local.json"
COMMITMENT = SECRET_DIR / "COMMITMENT.txt"
ENV_FILES = [REPO / "web" / ".env.local", REPO / "domain_fork" / ".env.local"]
SUPPLY = 15042
DOMAIN = "arc-uniques/1"


def canonical(ids: list[int], salt: str) -> bytes:
    payload = {"domain": DOMAIN, "ids": ids, "salt": salt}
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def commitment_of(ids: list[int], salt: str) -> str:
    return hashlib.sha256(canonical(ids, salt)).hexdigest()


def windows(supply: int, n: int) -> list[tuple[int, int]]:
    """Split 1..supply into n contiguous windows (front-loaded remainders)."""
    base, extra = divmod(supply, n)
    out, lo = [], 1
    for i in range(n):
        width = base + (1 if i < extra else 0)
        out.append((lo, lo + width - 1))
        lo += width
    assert out[-1][1] == supply
    return out


def draw(ids_n: int, supply: int) -> list[int]:
    ids = [lo + secrets.randbelow(hi - lo + 1) for lo, hi in windows(supply, ids_n)]
    return ids


def check_shape(ids: list[int], pieces_n: int, supply: int) -> list[str]:
    problems = []
    if len(ids) != pieces_n:
        problems.append(f"ids count {len(ids)} != pieces {pieces_n}")
        return problems
    if len(set(ids)) != len(ids):
        problems.append("duplicate ids")
    if not all(isinstance(i, int) and 1 <= i <= supply for i in ids):
        problems.append("id out of range")
    for (lo, hi), i in zip(windows(supply, pieces_n), ids):
        if not (lo <= i <= hi):
            problems.append(f"id {i} outside its window {lo}..{hi}")
    return problems


def set_env(env_path: Path, ids: list[int]) -> str:
    line = "UNIQUES_IDS=" + ",".join(str(i) for i in ids)
    if env_path.exists():
        text = env_path.read_text()
    else:
        text = "NEXT_PUBLIC_LAUNCH_MODE=live\n"
    lines = [l for l in text.splitlines() if not l.startswith("UNIQUES_IDS=")]
    lines.append(line)
    env_path.write_text("\n".join(lines) + "\n")
    return "updated" if "UNIQUES_IDS=" in text else "added"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="draw once and seal")
    ap.add_argument("--force", action="store_true", help="re-draw (re-seals the commitment)")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--reveal", action="store_true")
    ap.add_argument("--check-reveal", nargs=2, metavar=("IDS", "SALT"))
    args = ap.parse_args()

    registry = json.loads(REGISTRY.read_text())
    pieces = registry["pieces"]
    n = len(pieces)

    if args.check_reveal:
        ids_raw, salt = args.check_reveal
        ids = [int(x) for x in ids_raw.split(",")]
        if not COMMITMENT.exists():
            print("no published commitment found")
            return 1
        published = [l for l in COMMITMENT.read_text().splitlines() if l.startswith("commitment:")]
        published_hash = published[0].split(":", 1)[1].strip()
        got = commitment_of(ids, salt)
        ok = got == published_hash
        print(f"published : {published_hash}")
        print(f"recomputed: {got}")
        print("MATCH — reveal is authentic" if ok else "MISMATCH — do NOT trust this reveal")
        return 0 if ok else 1

    if args.reveal:
        data = json.loads(SECRET.read_text())
        print(json.dumps({"domain": DOMAIN, "ids": data["ids"], "salt": data["salt"]}, indent=1))
        print(f"commitment: {commitment_of(data['ids'], data['salt'])}")
        return 0

    if args.verify:
        if not (SECRET.exists() and COMMITMENT.exists()):
            print("secret or commitment missing — nothing to verify")
            return 1
        data = json.loads(SECRET.read_text())
        problems = check_shape(data["ids"], n, SUPPLY)
        got = commitment_of(data["ids"], data["salt"])
        published = [l for l in COMMITMENT.read_text().splitlines() if l.startswith("commitment:")]
        ok = published and published[0].split(":", 1)[1].strip() == got
        for code, ident in zip(pieces, data["ids"]):
            print(f"  {code['code']} {code['name']:<15} -> id {ident}")
        print(f"commitment: {got} ({'matches published' if ok else 'MISMATCH'})")
        if problems:
            print("PROBLEMS:", problems)
            return 1
        return 0 if ok else 1

    if not args.write:
        print(__doc__)
        return 0

    if SECRET.exists() and not args.force:
        print("sealed ids already exist (ops/uniques/ids.local.json) — refusing to re-draw.")
        print("The commitment is the anchor; re-drawing requires --force and a NEW publication.")
        return 1

    ids = draw(n, SUPPLY)
    problems = check_shape(ids, n, SUPPLY)
    if problems:
        print("PROBLEMS:", problems)
        return 1
    salt = secrets.token_hex(16)
    commit = commitment_of(ids, salt)

    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    SECRET.write_text(json.dumps({"domain": DOMAIN, "supply": SUPPLY, "ids": ids, "salt": salt}, indent=1) + "\n")
    SECRET.chmod(0o600)
    COMMITMENT.write_text(
        "ARC uniques — commit-reveal commitment (arc-uniques/1)\n"
        f"payload  : sha256( canonical_json({{domain, ids[18], salt}}) ), keys sorted, no spaces\n"
        f"commitment: {commit}\n"
        "verify   : python3 art/v2/uniques/gen_ids.py --check-reveal \"<ids>\" <salt>\n"
        "note     : ids+salt stay sealed until the reveal (all 18 found, or sellout).\n"
    )
    for env_path in ENV_FILES:
        state = set_env(env_path, ids)
        print(f"env      : {state} {env_path.relative_to(REPO)} (UNIQUES_IDS, {n} ids)")

    print(f"sealed   : {SECRET.relative_to(REPO)} (0600) — ids NOT printed")
    print(f"commitment: {commit}")
    print(f"public   : {COMMITMENT.relative_to(REPO)}")
    print("NEXT: publish COMMITMENT.txt (repo + GitBook + X), set UNIQUES_IDS in Vercel (both projects), deploy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
