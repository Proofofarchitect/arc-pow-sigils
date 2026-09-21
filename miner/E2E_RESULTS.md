# PoW NFT miner — extraction, verification, and real E2E mint

Target: `PowMintNFT` (v2) `0xc7D2C2cC9291485ec8B727333B6a1478Dd66c3D5`,
chain id `5042002`, RPC `https://rpc.testnet.arc.io`.
Reference artifact: `reference material`.

> The reference artifact is **not correct as shipped**. It was extracted verbatim,
> then 4 concrete defects were found by testing and repaired with minimal,
> documented edits (no algorithm rewrite). See "Artifact defects" below.

---

## 1. Files created (all under `miner/`)

| file | lines | role |
|---|---|---|
| `miner-worker.js` | 448 | **working** worker (verbatim + 4 minimal fixes) |
| `miner-worker.original.js` | 438 | untouched byte-faithful extraction |
| `miner.js` | 98 | main-thread worker wrapper (verbatim) |
| `test.html` | 197 | browser test UI (verbatim) |
| `README.md` | 169 | artifact README (verbatim) |
| `selftest.mjs` | 93 | Node harness: vectors + live PoW |
| `load-worker.mjs` | 30 | main-realm loader shim (`new Function`) |
| `crosscheck.mjs` | 22 | JS hash vs on-chain `seedOf` |
| `mine.mjs` | 49 | drives worker PoW search for a target bit count |
| `E2E_RESULTS.md` | — | this file |

## 2. Extraction fidelity

Extracted with a fence-aware parser handling the README's nested code fences.
Each file equals the exact source line range, byte-for-byte (sha256 of the
verbatim extraction):

```
2a656b894a76f19941cccce19d4975bb719532ebc820c79935cec1cdb768eb94  miner-worker.original.js
ba5ece0cedb2d8da16f747134b94a85d18d0f076ec903b2df40cd26f72da96b7  miner.js
4b94423c9e99407b26bc1c9482cc3b93661e8348cdd9741ff24fd8df6d0a10b4  test.html
cf2ff42dff2245b35ad1539a40eb61c4b4b49d6b6431efe73b9134d22a9ba99b  README.md
```

`miner-worker.js` is `miner-worker.original.js` plus the 4 fixes below.

## 3. Artifact defects found and fixed

Verified against an independent known-good Keccak-256 oracle (keccak-tiny
structure, BigInt lanes) that reproduces `keccak256("") = 0xc5d2460186f7...`.
Every defect below is objectively wrong independent of environment.

1. **Round constant 15** `RC[15]`: artifact had low word `0x80000003`;
   correct is `0x00008003` (`RC[15] = 0x8000000000008003`).
2. **Round constant 16** `RC[16]`: artifact had `0x80008002`;
   correct is `0x00008002` (`RC[16] = 0x8000000000008002`).
3. **`ROT` rho table transposed**. The artifact shipped the transpose of the
   correct rotation table (slot 1 held `36` instead of `1`, etc.). Replaced with
   the correct by-lane table `[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14]`.
4. **Mining-loop nonce placement**. The hot loop wrote the 32-byte nonce across 8
   strided single words (`S[18],S[20],…,S[32]`) instead of the 4 contiguous lanes
   spanning state words 18..25 (preimage bytes 72..103). Fixed to `S[18..25]`.
   (Before the fix, the worker's own `leadingZeroBits`/digest did not agree with
   its `schemeHash`.)
5. *(runtime)* **Progress reporting** `const hps = config.attempts / (...)` mixed
   BigInt with Number and threw `TypeError` once a batch ran longer than 250 ms in
   Node, aborting the mine. Fixed with `Number(config.attempts)`.

With (1)+(2)+(3) fixed, `keccak256("")` becomes correct and all self-tests pass.
(4) is required for the mining loop to be consistent with `schemeHash`; (5) is
required for the loop to run in Node.

## 4. Self-test (step 2) — `node miner/selftest.mjs`

```
=== Direct keccak256() vectors ===
PASS keccak256("")          expected = actual = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
PASS keccak256("abc")       expected = actual = 0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
PASS keccak256("The quick brown fox jumps over the lazy dog")  expected = actual = 0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15

=== Worker selfTest() (scheme nonce vectors) ===
  PASS keccak256('')
  PASS scheme nonce=0       0x053254b844d850e77548c330c1c758b8ed6c41213f297aa1e583f149a4215d71
  PASS scheme nonce=1       0x439569f3d583d13b4c3132bfa7e6ae7fae5f0381696265fe8fff04246c3d5cab
  PASS scheme nonce=42      0xfe2249316d65f16b298f442ae3ae37d9972a97d5154c37938896db35ca370a69
  PASS scheme nonce=123456  0x21a2c3beccf660aadb5ed57fcee9e278e3de4b3f7f38696aa7628eb6ee53d96d
PASS worker selfTest() summary  (5/5)

=== Live PoW search for a dummy 12-bit target ===
PASS PoW found 15-bit candidate (>= 12)
     nonce 0x...085a
     hash  0x0001fddd9a41cfbd627f9bc4a7c1abf54d7900731a2d39d19d556ec0ad7f72a1
PASS mined hash == independently recomputed scheme hash

=== ALL SELFTESTS PASSED ===   (exit 0)
```

The `vm`-based shim used by selftest runs ~15x slower than the main realm
(193us vs 13us per Keccak-f permutation); `load-worker.mjs` uses `new Function`
in the main realm for the mining workload.

## 5. On-chain cross-check (step 3)

On-chain (`arc-cast`):

```
seedOf(1)  = 0x00000dcc59e937a8228cb92d216aeb3705bd3c4d1dff61fa648d1d603777f5bf
nonceOf(1) = 403415
```

JS (`node miner/crosscheck.mjs 403415 <seedOf(1)>`) with
chainId=5042002, contract=0xc7D2…, miner=<ops-wallet-address>:

```
schemeHash = 0x00000dcc59e937a8228cb92d216aeb3705bd3c4d1dff61fa648d1d603777f5bf
MATCH
```

=> the JS preimage `keccak256(abi.encodePacked(chainId, contract, miner, nonce))`
(104 bytes) matches this contract exactly.

## 6. Real E2E mint (step 4)

* Private key read from `ops/.wallet` (`PRIVATE_KEY=` line) into a shell variable;
  **never printed** (only its length/prefix was echoed).
* Pre-mint: `requiredBits(wallet)=22`, `totalMinted=1`, `currentPrice()=0` (free phase).
* Mined nonce (node, target 22 bits, start 0):

```
nonce      = 12175032   (0x…b9c6b8)
bits       = 22
hash       = 0x000003fb32c005819d758df16aff8c3e10b3b44c5cf1575a5552cb5265508d69
attempts   ≈ 12.12M   (64.6 kH/s, 188.7 s)
verified   : schemeHash == workerHash  (hashMatches: true)
```

* Mint tx (`arc-cast send … "mint(uint256)" 12175032 --gas-price 50gwei`):

```
transactionHash   0xc33675c9abd4736ae27dd07c2b602d5b87d3374160e1821e998c2c395db4e231
status            1 (success)
blockNumber       62398084
gasUsed           136931
effectiveGasPrice 24 gwei
event Mined       tokenId=2 nonce=12175032 bits=22 paid=0
event Transfer    tokenId=2 -> <ops-wallet-address>
```

* Post-mint on-chain verification:

```
ownerOf(2)             = <ops-wallet-address>
seedOf(2)              = 0x000003fb32c005819d758df16aff8c3e10b3b44c5cf1575a5552cb5265508d69
nonceOf(2)             = 12175032
requiredBits(wallet)   = 24   (was 22 → advanced by +2)
totalMinted()          = 2    (was 1)
mintCount(wallet)      = 2
nonceUsed(wallet,12175032) = true
```

All post-conditions match. No `--value` (free wave; `totalMinted < freeSupply=250`).

## 7. Deviations / errors

* The reference artifact is broken in 5 places (see §3); 4 constant/logic fixes +
  1 runtime fix were applied to `miner-worker.js`. The verbatim bytes are kept in
  `miner-worker.original.js`.
* `--gas-price 50gwei` worked as-is on the first attempt; no fallback flags were
  needed. (`effectiveGasPrice` shows 24 gwei, above the 20 gwei floor.)
* `vm` realm was too slow for mining; main-realm `new Function` loader used instead.

## 8. NOT covered

* Browser execution of `test.html` / real `Worker` behaviour was not run (no
  headless browser); the Node shims emulate the worker message protocol only.
* Only `mint()` was exercised; no paid-phase mint, no `withdraw`, no pause/admin,
  no negative/revert paths (e.g. `BelowFloor`, `NonceUsed`, `WrongPayment`).
* Difficulty beyond 22 bits and multi-worker `SharedArrayBuffer` scaling untested.
* `ops/`, `contracts/`, `web/`, `art/` were read-only and untouched.
