#!/usr/bin/env python3
"""
agent_craft.py — MINIMAL headless reference: craft two House Cards into one (2→1)
**without the website**. Demonstrates the new salt-based commit-reveal flow (v1.0.1):

    commitPreimage = keccak256(abi.encode(SlotChoice[] choices, bytes32 salt))
    commit(cardA, cardB, commitPreimage, boostTier)   // payable: craftFee + boostCost
    reveal(commitId, choices, salt)                   // permissionless; window [commit+3, commit+258]

Salt rules (W3-01 — read before adapting):
  * The salt is a **client-side secret**. Keep it private until you reveal.
  * Losing the salt = the craft can **never be revealed**. Your only recourse is
    `refund(commitId)` AFTER the window — returns the two CARDS but **not** the fee.
    (Exception: if the core's `forgePaused()` is set at refund time, the full fee is returned.)
  * salt must be **non-zero** (a zero salt is rejected at commit with `BadHash`).
  * The contract does **NOT** check entropy quality — `entropy = blockhash(commitBlock + 2)`
    is a public chain value. The salt only stops a third party from *force-settling* your
    commit (brute-forcing the preimage); it does not add randomness to the child.

Flow implemented here (matching HC/2 spec v1.0.1):
    (0) config from env      (1) read controller state      (2) approve ×2 cards
    (3) fresh salt each commit (persisted BEFORE the tx)     (4) commit with exact msg.value
    (5) wait ≥ MIN_REVEAL_DELAY blocks                       (6) reveal(commitId, choices, salt)
    (7) print the Crafted event / childId
    (8) fallback note: missed window → refund() after +REVEAL_WINDOW (fee not returned)

⚠ SECURITY: this script signs a raw transaction with `PRIVATE_KEY` from the environment.
  Use a **throwaway test key / your own key ONLY**. Never paste a mainnet key into a shell
  you do not control. It is testnet-oriented (chain 5042002) and read-only until the commit.

Dependencies (same stack as `repo tooling`): eth_abi, eth_utils, web3 (eth_account ships with web3).
No new third-party imports are introduced.

Usage:
    CONTROLLER=0x... PRIVATE_KEY=0x... python3 agent_craft.py \
        --cards 7,8 --tier 1 --choices "0:0,1:1"

    # read-only dry run (no tx, no spend):
    CONTROLLER=0x... PRIVATE_KEY=0x... python3 agent_craft.py --cards 7,8 --tier 1 --dry-run

    # escape an expired commit (returns cards; fee is kept unless the core forge is paused):
    CONTROLLER=0x... PRIVATE_KEY=0x... python3 agent_craft.py --refund 1
"""
import argparse
import json
import os
import secrets
import sys
import time

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_utils import to_checksum_address
from web3 import Web3

# --------------------------------------------------------------------------- constants

RPC_DEFAULT = "https://rpc.testnet.arc.io"
CHAIN_ID = 5042002
# Arc silently drops transactions priced below ~20 gwei; ops uses a 50 gwei legacy price.
GAS_PRICE = 50_000_000_000
# Forged children get ids starting at FORGE_ID_BASE (HC/2 spec §1: id = 10M + forgedCount).
FORGE_ID_BASE = 10_000_000
# Wait cap for the reveal window (blocks are ~1s on Arc; 12 min is generous).
WAIT_CAP_S = 12 * 60

STATE_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".agent_craft_state.json")

# Minimal ABI for the bits this script touches (no need to fetch a verified ABI).
CTRL_ABI = [
    {"type": "function", "name": "paused", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "craftFee", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "boostCost", "stateMutability": "view",
     "inputs": [{"type": "uint8", "name": "tier"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "maxChosen", "stateMutability": "view",
     "inputs": [{"type": "uint8", "name": "tier"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "MIN_REVEAL_DELAY", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "REVEAL_WINDOW", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "ENTROPY_DELAY", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "nft", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "lastCommitId", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "commits", "stateMutability": "view",
     "inputs": [{"type": "uint256", "name": ""}],
     "outputs": [
         {"type": "address", "name": "player"},
         {"type": "uint256", "name": "cardA"},
         {"type": "uint256", "name": "cardB"},
         {"type": "bytes32", "name": "choicesHash"},
         {"type": "uint8", "name": "boostTier"},
         {"type": "uint64", "name": "nonce"},
         {"type": "uint64", "name": "commitBlock"},
         {"type": "uint256", "name": "fee"},
         {"type": "bool", "name": "revealed"},
         {"type": "bool", "name": "refunded"},
     ]},
    {"type": "function", "name": "commit", "stateMutability": "payable",
     "inputs": [
         {"type": "uint256", "name": "cardA"},
         {"type": "uint256", "name": "cardB"},
         {"type": "bytes32", "name": "slotChoicesHash"},
         {"type": "uint8", "name": "boostTier"},
     ], "outputs": []},
    {"type": "function", "name": "reveal", "stateMutability": "nonpayable",
     "inputs": [
         {"type": "uint256", "name": "commitId"},
         {"type": "tuple[]", "name": "choices",
          "components": [{"type": "uint8", "name": "slot"}, {"type": "uint8", "name": "parent"}]},
         {"type": "bytes32", "name": "salt"},
     ], "outputs": []},
    {"type": "function", "name": "refund", "stateMutability": "nonpayable",
     "inputs": [{"type": "uint256", "name": "commitId"}], "outputs": []},
    {"type": "event", "name": "Crafted", "anonymous": False, "inputs": [
        {"type": "uint256", "name": "commitId", "indexed": True},
        {"type": "address", "name": "player", "indexed": True},
        {"type": "uint256", "name": "cardA", "indexed": False},
        {"type": "uint256", "name": "cardB", "indexed": False},
        {"type": "bytes32", "name": "childSeed", "indexed": False},
        {"type": "bytes32", "name": "entropy", "indexed": False},
        {"type": "tuple[]", "name": "choices", "indexed": False,
         "components": [{"type": "uint8", "name": "slot"}, {"type": "uint8", "name": "parent"}]},
    ]},
]

NFT_ABI = [
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"type": "address", "name": "to"}, {"type": "uint256", "name": "tokenId"}],
     "outputs": []},
    {"type": "function", "name": "ownerOf", "stateMutability": "view",
     "inputs": [{"type": "uint256", "name": "tokenId"}], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "isFreeToken", "stateMutability": "view",
     "inputs": [{"type": "uint256", "name": "tokenId"}], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "currentWave", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "seedOf", "stateMutability": "view",
     "inputs": [{"type": "uint256", "name": "tokenId"}], "outputs": [{"type": "bytes32"}]},
    {"type": "function", "name": "totalForged", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
]

# --------------------------------------------------------------------------- plumbing

def die(msg, code=1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def build_w3():
    """Connect, using env overrides; no network call happens until a read/tx."""
    rpc = os.environ.get("RPC", RPC_DEFAULT)
    w3 = Web3(Web3.HTTPProvider(rpc))
    return w3


def load_config():
    """Step (0): read config from the environment. Never print the private key."""
    rpc = os.environ.get("RPC", RPC_DEFAULT)
    controller = os.environ.get("CONTROLLER")
    private_key = os.environ.get("PRIVATE_KEY")
    if not controller:
        die("CONTROLLER is not set (e.g. CONTROLLER=0x... )")
    if not private_key:
        die("PRIVATE_KEY is not set")
    acct = Account.from_key(private_key)
    print("== agent_craft — headless craft 2→1 ==")
    print("  RPC        :", rpc)
    print("  CONTROLLER :", to_checksum_address(controller))
    print("  player     :", acct.address, "(key never printed)")
    print("  chainId    :", CHAIN_ID)
    print("  ⚠ test/own throwaway key only — this script signs and spends real value.")
    return rpc, to_checksum_address(controller), acct


def send(w3, acct, fn, value=0, gas=1_000_000):
    """Sign + broadcast one legacy tx (mirrors repo tooling)."""
    tx = {
        "chainId": CHAIN_ID,
        "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
        "gasPrice": GAS_PRICE,
        "gas": gas,
        "value": value,
        "data": fn._encode_transaction_data(),
        "to": fn.address,
    }
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    txh = w3.eth.send_raw_transaction(raw)
    rec = w3.eth.wait_for_transaction_receipt(txh, timeout=300)
    print(f"    tx {txh.hex()}  status={rec.status}  gas={rec.gasUsed}  block={rec.blockNumber}")
    if rec.status != 1:
        die(f"transaction reverted: {txh.hex()}")
    return rec


def commit_preimage(w3, choices, salt):
    """keccak256(abi.encode(SlotChoice[] choices, bytes32 salt)) — the on-chain preimage."""
    salt_b = bytes(salt)
    if len(salt_b) != 32:
        die("salt must be exactly 32 bytes")
    return w3.keccak(abi_encode(["(uint8,uint8)[]", "bytes32"], [choices, salt_b]))


def parse_choices(spec):
    """Parse "slot:parent,slot:parent,..." → list[(slot, parent)] (contract order)."""
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            die(f"bad --choices item {part!r}; expected 'slot:parent'")
        slot_s, parent_s = part.split(":", 1)
        out.append((int(slot_s), int(parent_s)))
    return out


def validate_choices(choices, max_chosen):
    """Mirror the contract's structural checks so we fail early (HC/2 spec §3)."""
    if len(choices) > max_chosen:
        die(f"too many choices: {len(choices)} > maxChosen {max_chosen}")
    prev = -1
    for slot, parent in choices:
        if slot > 11:
            die(f"slot {slot} out of range (max 11; legendary 12 is entropy-only)")
        if slot <= prev:
            die("slots must be strictly increasing (unique)")
        if parent > 1:
            die(f"parent {parent} invalid (0 = lower tokenId, 1 = higher)")
        prev = slot


def save_state(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=1)


# --------------------------------------------------------------------------- steps

def step_read(ctrl, nft):
    """Step (1): read the controller's live parameters before spending anything."""
    paused = ctrl.functions.paused().call()
    craft_fee = ctrl.functions.craftFee().call()
    min_delay = ctrl.functions.MIN_REVEAL_DELAY().call()
    window = ctrl.functions.REVEAL_WINDOW().call()
    entropy_delay = ctrl.functions.ENTROPY_DELAY().call()
    nft_addr = to_checksum_address(ctrl.functions.nft().call())
    print("\n[1] controller read")
    print("    paused            :", paused)
    print("    craftFee          :", craft_fee, f"({craft_fee / 1e18:.4f} USDC)")
    print("    MIN_REVEAL_DELAY  :", min_delay, "blocks (earliest reveal = commit +", min_delay, ")")
    print("    REVEAL_WINDOW     :", window, "blocks (latest reveal = commit +", window, ")")
    print("    ENTROPY_DELAY     :", entropy_delay, "blocks (entropy = blockhash(commit +", entropy_delay, "))")
    print("    nft (core)        :", nft_addr)
    for tier in range(4):
        print(f"    tier {tier}: boostCost={ctrl.functions.boostCost(tier).call()} "
              f"maxChosen={ctrl.functions.maxChosen(tier).call()}")
    if nft_addr != to_checksum_address(nft.address):
        die(f"core mismatch: controller.nft()={nft_addr} vs NFT={nft.address}")
    return {"craftFee": craft_fee, "MIN_REVEAL_DELAY": min_delay,
            "REVEAL_WINDOW": window, "ENTROPY_DELAY": entropy_delay, "paused": paused}


def step_approve_and_commit(w3, ctrl, nft, acct, cards, tier, choices, state_path):
    """Steps (2)-(4): approve ×2, mint a fresh salt, persist it, then commit."""
    card_a, card_b = cards
    if card_a == card_b:
        die("cardA == cardB (the contract reverts SameCard)")
    for c in cards:
        owner = to_checksum_address(nft.functions.ownerOf(c).call())
        if owner != acct.address:
            die(f"card {c} owner is {owner}, not {acct.address}")
        if nft.functions.isFreeToken(c).call() and nft.functions.currentWave().call() < 5:
            die(f"card {c} is a free token and wave < 5 (FreeTokenLocked)")

    print("\n[2] approve controller for both cards")
    for c in cards:
        send(w3, acct, nft.functions.approve(ctrl.address, c), gas=120_000)

    print("\n[3] fresh salt (secret, 32 random bytes) — persisted BEFORE the commit tx")
    salt = secrets.token_bytes(32)          # a NEW salt every commit; never reuse
    if salt == bytes(32):
        die("zero salt (astronomically unlikely) — rerun")
    choices = [tuple(c) for c in choices]
    preimage = commit_preimage(w3, choices, salt)

    commit_record = {
        "player": acct.address,
        "controller": ctrl.address,
        "cardA": card_a, "cardB": card_b, "boostTier": tier,
        "choices": [[s, p] for (s, p) in choices],
        "salt": "0x" + salt.hex(),
        "commitPreimage": preimage.hex(),
        "commitId": None, "commitBlock": None, "fee": None, "created": time.time(),
    }
    save_state(state_path, {"commit": commit_record})
    print("    salt saved to", state_path, "(losing it forces a refund-only escape)")

    print("\n[4] commit with exact msg.value")
    fee = ctrl.functions.craftFee().call() + ctrl.functions.boostCost(tier).call()
    print(f"    fee = craftFee + boostCost = {fee} ({fee / 1e18:.4f} USDC)")
    rec = send(w3, acct, ctrl.functions.commit(card_a, card_b, preimage, tier), value=fee, gas=1_000_000)

    commit_id = ctrl.functions.lastCommitId().call()
    c = ctrl.functions.commits(commit_id).call()
    commit_block = int(c[6])
    commit_record.update({"commitId": commit_id, "commitBlock": commit_block, "fee": fee,
                          "commitTx": rec.transactionHash.hex()})
    save_state(state_path, {"commit": commit_record})
    print(f"    commitId={commit_id} commitBlock={commit_block} fee={c[7]}")
    if bytes(c[3]) != bytes(preimage):
        die("on-chain choicesHash != local preimage (should never happen)")
    return commit_record


def step_wait_and_reveal(w3, ctrl, nft, acct, commit_record, params):
    """Steps (5)-(7): wait for the window, reveal, decode the Crafted event."""
    commit_id = commit_record["commitId"]
    commit_block = commit_record["commitBlock"]
    salt = bytes.fromhex(commit_record["salt"][2:])
    choices = [tuple(c) for c in commit_record["choices"]]

    low = commit_block + params["MIN_REVEAL_DELAY"]
    high = commit_block + params["REVEAL_WINDOW"]

    print(f"\n[5] wait for reveal window [{low}, {high}]")
    t0 = time.time()
    n = w3.eth.block_number
    while n < low:
        if time.time() - t0 > WAIT_CAP_S:
            die(f"timed out waiting for block {low} (current {n})")
        time.sleep(2)
        n = w3.eth.block_number
        print(f"    … block {n}/{low}")
    if n > high:
        die(f"reveal window missed (now {n} > {high}); run --refund {commit_id}")

    print("\n[6] reveal(commitId, choices, salt)")
    forged_before = nft.functions.totalForged().call()
    rec = send(w3, acct, ctrl.functions.reveal(commit_id, choices, salt), gas=1_500_000)

    print("\n[7] Crafted event")
    logs = ctrl.events.Crafted().process_receipt(rec)
    if not logs:
        print("    (no Crafted event found — check the tx)")
        return
    ev = logs[0]["args"]
    child_seed = "0x" + bytes(ev["childSeed"]).hex()
    entropy = "0x" + bytes(ev["entropy"]).hex()
    child_id = FORGE_ID_BASE + forged_before  # id = FORGE_ID_BASE + forgedCount (HC/2 spec §1)
    print("    commitId  :", ev["commitId"])
    print("    player    :", ev["player"])
    print("    cardA/cardB:", ev["cardA"], "/", ev["cardB"])
    print("    childSeed :", child_seed)
    print("    entropy   :", entropy)
    print("    choices   :", [tuple(c) for c in ev["choices"]])
    print("    childId   :", child_id)
    on_chain_seed = "0x" + bytes(nft.functions.seedOf(child_id).call()).hex()
    print("    seedOf(childId) == childSeed :", on_chain_seed == child_seed)
    print("    ownerOf(childId) == player   :",
          to_checksum_address(nft.functions.ownerOf(child_id).call()) == acct.address)


def step_refund(w3, ctrl, acct, commit_id):
    """Escape hatch: call refund() after the window. Returns cards, keeps the fee."""
    c = ctrl.functions.commits(commit_id).call()
    if c[0] == "0x0000000000000000000000000000000000000000":
        die(f"no commit with id {commit_id}")
    commit_block = int(c[6])
    window = ctrl.functions.REVEAL_WINDOW().call()
    now = w3.eth.block_number
    print(f"    commit {commit_id}: commitBlock={commit_block} window ends at {commit_block + window} (now {now})")
    if now <= commit_block + window:
        die("refund window still open (refund reverts WindowOpen); wait or reveal instead")
    print("    calling refund() — cards return; FEE IS NOT RETURNED (unless core.forgePaused())")
    send(w3, acct, ctrl.functions.refund(commit_id), gas=300_000)
    print("    refunded. (Event Refunded carries the feeRefunded amount, usually 0.)")


def print_fallback_note():
    print("\n[8] fallback — if you missed the reveal window:")
    print("    • run:  python3 agent_craft.py --refund <commitId>")
    print("    • you get the two CARDS back, but the FEE is NOT returned (anti-grind premium).")
    print("    • exception: if the core's forgePaused() is set at refund time, the full fee is refunded.")
    print("    • the entropy block expires (blockhash window) — the window never extends, so don't wait.")


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Headless craft 2→1 reference (salt commit-reveal).")
    ap.add_argument("--cards", help="comma-separated token ids, e.g. 7,8 (2 cards required)")
    ap.add_argument("--tier", type=int, default=0, help="boost tier 0..3 (default 0)")
    ap.add_argument("--choices", default="0:0,1:1",
                    help='slot:parent list, strictly increasing slots, e.g. "0:0,1:1"')
    ap.add_argument("--refund", type=int, metavar="COMMIT_ID",
                    help="escape an expired commit instead of crafting (returns cards only)")
    ap.add_argument("--dry-run", action="store_true", help="read-only: print state and stop (no tx)")
    ap.add_argument("--state", default=STATE_DEFAULT, help="salt/commit json path")
    args = ap.parse_args()

    _, controller, acct = load_config()
    w3 = build_w3()
    if not w3.is_connected():
        die("cannot reach RPC")
    ctrl = w3.eth.contract(address=controller, abi=CTRL_ABI)
    nft_addr = to_checksum_address(ctrl.functions.nft().call())
    nft = w3.eth.contract(address=nft_addr, abi=NFT_ABI)

    params = step_read(ctrl, nft)

    if args.refund is not None:
        step_refund(w3, ctrl, acct, args.refund)
        return 0

    if not args.cards:
        die("--cards is required (two token ids, e.g. --cards 7,8)")
    cards = [int(x) for x in args.cards.split(",") if x.strip()]
    if len(cards) != 2:
        die(f"--cards needs exactly 2 ids, got {cards}")
    if not (0 <= args.tier <= 3):
        die("--tier must be 0..3 (tier 4 is reserved)")

    choices = parse_choices(args.choices)
    validate_choices(choices, ctrl.functions.maxChosen(args.tier).call())

    if args.dry_run:
        print("\n[dry-run] no transaction sent. Would commit cards", cards,
              "tier", args.tier, "choices", choices)
        return 0

    if params["paused"]:
        die("controller is paused (commit/reveal disabled); refund still works via --refund")

    commit_record = step_approve_and_commit(w3, ctrl, nft, acct, cards, args.tier,
                                            choices, args.state)
    step_wait_and_reveal(w3, ctrl, nft, acct, commit_record, params)
    print_fallback_note()
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
