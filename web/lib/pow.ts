import { concatHex, keccak256, toHex, type Address, type Hex } from "viem";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS } from "./contract";

/**
 * Client-side re-implementation of the contract's PoW check, matching
 * PowMintNFT.sol exactly:
 *
 *   work = keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce))
 *   valid <=> leadingZeroBits(work) >= requiredBits(miner)
 *
 * The miner worker targets this hash. Keeping a local copy lets the UI verify a
 * found nonce before paying gas (the contract would revert with BelowFloor
 * otherwise).
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
 * Minimal single-threaded grind used as a last-resort fallback and for local
 * verification. NOT meant for production mining — the web worker does the real
 * work. Returns the first nonce meeting `requiredBits`, or null if the budget
 * (`maxAttempts`) is exhausted.
 */
export function grindNonceSync(
  miner: Address,
  requiredBits: number,
  startNonce = 0n,
  maxAttempts = 250_000,
): { nonce: bigint; work: Hex; bits: number } | null {
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
