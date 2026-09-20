# Miner worker (installed)

This directory holds the PoW web worker and its main-thread wrapper, served as
static assets by Next.js from `/miner/*`:

| file | served at | role |
|---|---|---|
| `miner-worker.js` | `/miner/miner-worker.js` | the worker (`new Worker('/miner/miner-worker.js')`) |
| `miner.js` | `/miner/miner.js` | ES-module wrapper (`PowMiner`) used by the standalone test page |

`miner-worker.js` here is a **byte-identical copy** of the verified
`miner/miner-worker.js` (sha256
`28df0457fbeb06c6b19ccec139691dda68873274a5a6b688a34b5b7d14f62ded`). Do not edit
it in place — change the source under `miner/` and re-copy, so the browser copy
stays identical to the self-tested artifact.

> The original scaffold's `README.md` documented a *placeholder* protocol
> (`{type:"start", requiredBits}` / `{type:"found", nonce}`). That is **not** what
> the real worker speaks. The real protocol is below.

## Worker protocol (real)

```js
// page -> worker
{ type: "start", chainId, contract, miner, startNonce?, keep?, batchSize? }
{ type: "stop" }
{ type: "selftest" }

// worker -> page
{ type: "started",          startNonce }                 // 0x-prefixed 32-byte hex
{ type: "progress",         attempts, hashesPerSecond, bestBits, best, candidates }
{ type: "done",             reason, attempts, best }
{ type: "error",            message }
{ type: "selftest",         result, name, expected, actual }
{ type: "selftest-summary", result, passed, total }
```

Important differences from the old placeholder contract:

- The worker **does not take `requiredBits`** and never emits a `found` message.
  It continuously keeps the `keep` best candidates by leading-zero-bit count and
  streams them in `progress.best` (sorted by `bits` descending). **The caller**
  decides when a candidate clears the on-chain threshold and stops the worker.
- `attempts` is a **decimal string** (the worker counts in `BigInt`);
  the batched rate is `hashesPerSecond` (not `hashrate`); per-batch new best
  candidates are in `candidates`.

Each candidate is `{ nonce, hash, bits }`, where `hash` follows
`PowMintNFT.workFor(miner, nonce)`:

```text
work = keccak256(concat(chainid_uint256, contract_address, miner_address, nonce_uint256))
leadingZeroBits(work) >= requiredBits
```

The page re-verifies every offered nonce with `web/lib/pow.ts` (`computeWork`)
before minting, so a buggy worker cannot cause a wasted reverting transaction.
The typed main-thread wrapper lives in `web/lib/miner-client.ts`.

## Self-test

`miner/test.html` (standalone) and `web/lib/miner-client.ts`'s `selfTest()` both
drive the same in-worker vectors (keccak256("") + 4 scheme vectors). Verified in
headless Chromium: **PASS 5/5**.
