import { concatHex, keccak256, toHex, type Address, type Hex } from "viem";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS } from "./contract";

/**
 * Client-side re-implementation of the contract's PoW check (v3.4):
 *
 *   work = keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce))
 *   valid <=> uint256(work) < targetFor(miner)          (FRACTIONAL difficulty)
 *
 * v3.4 expresses difficulty in milli-bits, so the authoritative check is the
 * fractional target (`work < target`, read on-chain via `targetFor`), NOT a
 * "leading zero bits >= requiredBits" comparison. The worker still grinds to
 * `ceil(requiredMilli/1000)` leading zero bits — a conservative superset of the
 * target — and the page re-verifies each candidate against the exact target.
 */

/** Count leading zero bits of a 32-byte hash (bitstring order). clz(0)=256. */
export function leadingZeroBits(hash: Hex): number {
  let x = BigInt(hash);
  if (x === 0n) return 256;

  let z = 0;
  if (x >> 128n === 0n) z += 128;
  else x >>= 128n;
  if (x >> 64n === 0n) z += 64;
  else x >>= 64n;
  if (x >> 32n === 0n) z += 32;
  else x >>= 32n;
  if (x >> 16n === 0n) z += 16;
  else x >>= 16n;
  if (x >> 8n === 0n) z += 8;
  else x >>= 8n;
  if (x >> 4n === 0n) z += 4;
  else x >>= 4n;
  if (x >> 2n === 0n) z += 2;
  else x >>= 2n;
  if (x >> 1n === 0n) z += 1;

  return z;
}

/** Compute workFor(miner, nonce) locally. */
export function computeWork(
  miner: Address,
  nonce: bigint,
  contractAddress: Address = CONTRACT_ADDRESS,
  chainId: number = ARC_CHAIN_ID,
): Hex {
  return keccak256(
    concatHex([
      toHex(chainId, { size: 32 }),
      contractAddress,
      miner,
      toHex(nonce, { size: 32 }),
    ]),
  );
}

/**
 * The authoritative v3.4 acceptance check: a work hash is valid iff its uint256
 * value is strictly below `targetFor(miner)` (a fractional target that can sit
 * between whole leading-zero-bit values).
 */
export function meetsTarget(work: Hex, target: bigint): boolean {
  return BigInt(work) < target;
}

/** Display bits for a milli-bits difficulty: `ceil(milli / 1000)`. */
export function milliToBits(milli: bigint): number {
  return Number((milli + 999n) / 1000n);
}

/**
 * Minimal single-threaded grind used as a last-resort fallback and for local
 * verification. NOT meant for production mining — the web worker does the real
 * work. Grinds to `ceil(milli/1000)` leading zero bits (a superset of the exact
 * fractional target); callers re-check candidates with `meetsTarget`.
 */
export function grindNonceSync(
  miner: Address,
  milli: bigint,
  startNonce = 0n,
  maxAttempts = 250_000,
): { nonce: bigint; work: Hex; bits: number } | null {
  const requiredBits = milliToBits(milli);
  for (let i = 0; i < maxAttempts; i++) {
    const nonce = startNonce + BigInt(i);
    const work = computeWork(miner, nonce);
    const bits = leadingZeroBits(work);
    if (bits >= requiredBits) {
      return { nonce, work, bits };
    }
  }
  return null;
}
