# Dependency-free browser Keccak PoW miner

A pure JavaScript Web Worker miner for this exact preimage:

```text
keccak256(
  chainid(32-byte uint256 big-endian) ||
  contract(20 bytes) ||
  miner(20 bytes) ||
  nonce(32-byte uint256 big-endian)
)
```

The total input is exactly 104 bytes.

A digest has `n` leading zero bits when its byte sequence, read from byte `0` and most-significant bit first, begins with `n` zero bits.

The worker does not decide whether a candidate is valid for the current wallet difficulty. It reports the observed `bits` count for retained candidates, allowing the page or contract integration to compare it with the current `requiredBits`.

## Files

- `miner-worker.js` — Keccak-f[1600], Keccak-256, monotonic nonce search, candidate tracking, self-tests.
- `miner.js` — main-thread worker wrapper.
- `test.html` — standalone browser test UI.

## Running locally

Modern browsers generally disallow module workers from `file://` pages. Serve the files from any static HTTP server:

```sh
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/test.html
```

No package manager, npm package, CDN script, WebAssembly module, or third-party dependency is required.

## Worker API

Start mining:

```js
import { PowMiner } from "./miner.js";

const miner = new PowMiner("./miner-worker.js");

miner.onProgress = (data) => {
  console.log(data.attempts, data.hashesPerSecond, data.bestBits, data.best);
};

miner.onCandidate = (candidate) => {
  console.log(candidate.nonce, candidate.hash, candidate.bits);
};

miner.start({
  chainId: 5042,
  contract: "0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4", // v3.4 mainnet (Proof of Architect)
  miner: "0x2222222222222222222222222222222222222222",
  startNonce: 0,
  keep: 16,
  batchSize: 4096
});
```

> **Current contract (v3.4 "Proof of Architect"):** mainnet
> `0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4` (chainId `5042`).
> The PoW preimage layout is unchanged from v2 to v3.4 — only the bound contract address differs.

Stop mining:

```js
miner.stop();
```

Terminate the worker permanently:

```js
miner.terminate();
```

## Progress message

Progress is emitted approximately four times per second:

```js
{
  type: "progress",
  attempts: "1234567",
  hashesPerSecond: 456789,
  bestBits: 21,
  best: [
    {
      nonce: "0x...",
      hash: "0x...",
      bits: 21
    }
  ],
  candidates: []
}
```

`attempts` is serialized as a decimal string so it remains exact beyond JavaScript's safe integer range.

The nonce sequence is strictly monotonic, beginning from `startNonce` or `0` by default. It stops only when asked, restarted, terminated, or after uint256 nonce overflow.

## Candidate retention

The worker keeps the top `keep` candidates, sorted by:

1. Highest leading-zero-bit count.
2. Lowest nonce for ties.

A candidate event is included when a hash enters this retained best-candidate list. This avoids flooding `postMessage` with every hash while still exposing the best results for an escalating wallet difficulty.

## Self-test

From the test page, click **Run self-test**.

Or from JavaScript:

```js
miner.selfTest();
```

Expected output is five `PASS` lines:

```text
PASS keccak256('')
PASS scheme nonce=0
PASS scheme nonce=1
PASS scheme nonce=42
PASS scheme nonce=123456
PASS: 5/5
```

The checks include:

```text
keccak256("") =
c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
```

and all supplied mint-scheme vectors.

## Performance notes

This implementation uses paired unsigned 32-bit JavaScript values for Keccak's 64-bit lanes. That is substantially faster than a direct BigInt Keccak permutation in most browser engines.

A single worker on a typical current desktop CPU may achieve roughly:

```text
0.2–1.5 MH/s
```

Actual throughput varies substantially with browser engine, CPU generation, thermals, battery mode, and active tabs. Measure the displayed rate on the target browser rather than relying on an estimate.

### Optimization ideas

- Avoid allocations in the hot loop. The worker reuses Keccak state arrays and only creates strings/objects when a candidate enters the retained best list.
- Keep the fixed 72-byte prefix and Keccak padding pre-absorbed in a base state, then overwrite only the four nonce lanes for each hash.
- Increase `batchSize` for slightly higher throughput, at the cost of slower stop responsiveness. Values around `4096`–`65536` are usually reasonable.
- Run several workers over disjoint nonce ranges if independent ranges are acceptable. For example, worker `i` can start at `i * rangeSize`.
- Use `SharedArrayBuffer` plus cross-origin isolation if coordinating multiple workers, stop flags, or work distribution is needed.
- WebAssembly SIMD or a carefully optimized native/WASM Keccak implementation can outperform pure JavaScript, but is intentionally not used here.
- Avoid rendering every candidate or every hash on the main thread. This implementation posts aggregate progress only about four times per second.

## Important Keccak detail

This uses Ethereum-style `keccak256`, including Keccak's `0x01 ... 0x80` padding. It is not NIST SHA3-256, which uses different domain-separation padding and would produce different hashes.
