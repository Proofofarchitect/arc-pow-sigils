# Arc PoW NFT — GPU miner (`mining/gpu/`)

CUDA miner for the **Arc testnet** proof-of-work NFT collection, adapted from
`crypto/hashcats/mining/gpu/gpu_mine.py`. It grinds the contract's exact preimage and
broadcasts `mint(nonce)`.

> **Status:** the preimage + difficulty logic is **[proven] on CPU** against the on-chain
> ground-truth vector (token #1). The **CUDA execution path is `[assumed]` — untested here**
> because this workstation has no GPU. Validate on a rented GPU with `--dry-run` first.

> **Current contract (v3 "Proof of Architect"):** testnet `0xCc223C0e1A943916f604d729Cddfb5B85f266193`
> (chainId `5042002`). **Mainnet (5042) address: TBD.** Override with `--contract` / `--chain-id`
> / `--rpc`; the PoW preimage is unchanged between v2 and v3 (only the bound address differs).

---

## 1. The formula (contract `PowMintNFTv3.sol`)

```solidity
work = keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce));
valid  ⟺  _leadingZeroBits(work) >= requiredBits(miner);
requiredBits(miner) = baseBits + 2*epochIndex + loadAdjust + streakBits;  // capped at 250 (v3)
```

Packed encoding is **104 bytes** = exactly one Keccak rate block (`rate = 136`):

| offset | size | field                    |
|-------:|-----:|--------------------------|
| 0      | 32   | `block.chainid` (uint256 BE) |
| 32     | 20   | `address(this)` (contract)   |
| 52     | 20   | `miner` (`msg.sender`)       |
| 72     | 32   | `nonce` (uint256 BE)         |
| 104    | —    | Keccak padding `0x01 … 0x80` |

`_leadingZeroBits` counts zero bits from the **MSB of the big-endian digest**; `clz(0)=256`
(never hit in practice). Verified against the contract source and reproduced on-chain.

---

## 2. Files

| file | role |
|------|------|
| `gpu_mine.py` | CUDA miner: builds the 104-B preimage, runs the kernel, verifies hits on CPU, submits `mint(nonce)`. |
| `verify_vector.py` | **CPU-only proof.** Recomputes the known vector hash and asserts it equals the on-chain `seedOf(1)`; re-ports `_leadingZeroBits` and cross-checks it. |
| `cpu_mine.py` | Tiny CPU reference miner (pure-Python keccak) at low difficulty; no transactions. |

Run the two CPU checks **before** renting a GPU — they need no GPU and no key:

```bash
cd mining/gpu
python3 verify_vector.py          # expects: RESULT: ALL PASS
python3 cpu_mine.py --bits 12     # expects: RESULT: PASS
```

---

## 3. Ground-truth vector [proven] — v2 instance (historical)

> Produced on the **v2** instance and kept unchanged to preserve the historical proof. The
> current **v3** instance is `0xCc223C0e1A943916f604d729Cddfb5B85f266193`; the preimage layout
> is identical, so the same verification applies with that address.

```
chainId  = 5042002
contract = 0xc7D2C2cC9291485ec8B727333B6a1478Dd66c3D5   # v2 (historical)
miner    = <ops-wallet-address>
nonce    = 403415
seedOf(1)= 0x00000dcc59e937a8228cb92d216aeb3705bd3c4d1dff61fa648d1d603777f5bf
```

`verify_vector.py` recomputes `keccak256(chainId‖contract‖miner‖nonce)` and it matches
`seedOf(1)` byte-for-byte; the hash has **20** leading zero bits = `baseBits` (token #1 was the
first mint of that wallet, so `requiredBits = baseBits = 20`). Confirmed on-chain (v2 instance):
`baseBits()=20`, `escalationBits()=2`, `nonceOf(1)=403415`.

---

## 4. Run on a rented GPU (Vast.ai / Lium — 3090 / 4090)

Testnet RPC `https://rpc.testnet.arc.io`, chain id `5042002`, contract default
`0xCc223C0e1A943916f604d729Cddfb5B85f266193` (v3).
Expected rates: **3090 ≈ 2 GH/s, 4090 ≈ 4.8 GH/s** (H100 ≈ 7 GH/s via the hashcats Modal path).

```bash
# on the rented box
pip install --break-system-packages cupy-cuda12x eth-account eth-hash[pycryptodome]

# 1) dry-run first: mines + verifies, NEVER broadcasts
PRIVATE_KEY_FILE=~/arc.key python3 gpu_mine.py --gpus 0 --dry-run

# 2) smoke test an artificially easy target, then live small
python3 gpu_mine.py --pk "$(cat ~/arc.key)" --gpus 0 --test-bits 12 --dry-run
python3 gpu_mine.py --pk "$(cat ~/arc.key)" --gpus 0,1 --max-mints 1
```

On startup the miner runs a **kernel↔Python keccak parity self-test**; if it fails it exits
non-zero. Every hit is re-verified in Python (`keccak` + leading-zero count) before submission.

### Key / env hygiene (mandatory)

- **Never commit a private key.** Pass it via `$PRIVATE_KEY` or `--pk "$(cat ~/arc.key)"`.
  The miner only feeds it to `Account.from_key()` and **never prints it**.
- Keep the key file **outside the repo** (e.g. `~/arc.key`); confirm `mining/` is git-ignored.
- Use a dedicated throw-away wallet funded with small native USDC.

### Arc fee rule (baked in)

`maxFeePerGas ≥ 20 gwei`, otherwise the Arc mempool **silently drops** the tx. `gpu_mine.py`
sets `maxFeePerGas = max(2 × gasPrice, 20 gwei)` and caps the priority fee at it. USDC is the
**native gas token with 18 decimals** (`msg.value` = `currentPrice()` in 18-dec wei; `0` during
the free wave). Do **not** send the 6-decimal ERC-20 USDC form.

### Testnet → mainnet

Mainnet (chainId `5042`) is **not live yet — the contract address is TBD**. When it is, override:

```bash
python3 gpu_mine.py --rpc https://rpc.mainnet.arc.io --chain-id 5042 \
    --contract 0x<MAINNET_CONTRACT_TBD> --gpus 0,1,2,3
```
`--contract`/`--chain-id`/`--rpc` are all overridable; the v3 **testnet** defaults are built in
(`0xCc223C0e1A943916f604d729Cddfb5B85f266193`, chainId `5042002`). Extra same-chain RPCs:
`ARC_RPC_FALLBACKS=url1,url2`.

---

## 5. Diff vs the original `hashcats/mining/gpu/gpu_mine.py`

Every change is listed:

1. **Preimage / `build_block`** — hashcats built `miner(20)‖stream(4)‖counter(8)‖prev(32)‖anchor(32)`
   (116 B). Ours builds `chainId(32)‖contract(20)‖miner(20)‖nonce(32)` = **104 B**, padding at
   byte 104 (`0x01`) and 135 (`0x80`).
2. **CUDA kernel `mine_kernel`** — the varying region moved from lanes 5–6 to **lanes 11–12**
   (bytes 88–103 = the high/low 64-bit words of `nonce = (hi64<<64)|counter`). Both words are
   `bswap64`'d into the little-endian Keccak lanes, and the hit test runs on the `bswap64`'d top
   lane (`top <= target_top`) — i.e. the two silent hashcats GPU-port traps both apply to our
   formula and are handled the same way as the original.
3. **Job fetch** — hashcats polled `prevWork/currentAnchor/targetFor/mintPrice`. Ours polls
   `requiredBits(address)`, `currentPrice()`, `totalMinted()` (+ `eth_getBalance`). There is
   **no `prev`/`anchor` chain** — the preimage is static for a given `(chainId, contract, miner)`.
4. **Difficulty model** — hashcats compared `work < target`. We compute
   `target_top = (1<<(64-bits))-1` from `requiredBits` and test `top <= target_top`
   (exact for `bits ≤ 64`; the realistic range). v3 difficulty has three layers — wave base
   (`+2/wave`), load regulator, and a per-wallet streak — all served live by the on-chain
   `requiredBits(miner)` view and picked up by the poller.
5. **`mine(uint256)` calldata** — single 32-byte nonce arg (hashcats used `mine(uint256,uint256)`).
6. **Fee rule** — `maxFeePerGas = max(gasPrice×2, 20 gwei)` to satisfy the Arc mempool floor
   (the original could set a fee below the floor and get silently dropped).
7. **Nonce space** — 128-bit nonce `(hi64<<64)|counter` with a per-GPU `hi64` so cards never
   duplicate work; the hit tuple carries `hi64` for exact reconstruction.
8. **Submission discipline** — hits are dispatched through a **single serialized submitter**
   with a `--mint-interval` throttle (low difficulty produces ~2^-(bits-30) hits/s, so an
   unthrottled flood would be harmful), plus a balance/supply guard and `--max-mints`.
9. **RPC** — Arc primary `https://rpc.testnet.arc.io`; extra same-chain endpoints via
   `ARC_RPC_FALLBACKS` (no cross-chain fallback, unlike the original's RH set).
10. **USDC notes** in comments/README (native 18-dec gas token).
11. **Self-test** — kernel↔Python keccak parity on the 104-byte preimage before mining.

---

## 6. What is NOT verified here

- **CUDA execution.** No GPU on this host, so `mine_kernel` was never executed. Its `keccakf`
  is byte-identical to the proven hashcats kernel; only the lane placement and target test
  changed, and both were validated on CPU (lane-placement assertion + the on-chain vector).
  `[assumed]` until the on-GPU self-test and a `--dry-run` run pass.
- **Live submission.** No transaction was sent from here (per task scope). The submit path is
  copied from the proven hashcats wallet handling with only the fee/calldata changes.
- **`bits > 64`.** The kernel's 64-bit top-word test is exact only for `bits ≤ 64`; v3 starts at
  `baseBits = 30` and adds `+2/wave`, so the realistic range stays well under 64. The host raises
  rather than silently mis-accepting.

---

## 7. Safety

- No transactions, no key handling, and no git changes were made while producing/verifying these scripts.
- `verify_vector.py` and `cpu_mine.py` are pure CPU, keyless, network-read-only (vector fetch).
