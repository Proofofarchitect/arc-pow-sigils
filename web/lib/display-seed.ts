import {
  concatHex,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "./contract";

/**
 * display-seed.ts — post-inclusion entropy (contract v3.4).
 *
 * The core stores TWO values per token:
 *   * `seedOf[id]`      — the PoW work hash, claim hash, or craft pre-seed;
 *   * `mintBlockOf[id]` — the block the token was minted/forged in (0 for claim tokens).
 *
 * The DISPLAY seed that drives traits / rarity / art is:
 *
 *   mintBlockOf == 0        →  seedOf                       (claim tokens: deterministic)
 *   mintBlockOf  > 0        →  keccak256(seedOf ‖ blockhash(mintBlockOf + SEED_DELAY_BLOCKS))
 *
 * `mintBlockOf + 2` is deliberately a block that does NOT exist when the miner
 * submits the mint, so a miner cannot grind nonces to pick a favourable seed
 * (no free rarity grinding). Block hashes are permanently readable via RPC, so
 * no keeper / second transaction is needed.
 *
 * Pending state: right after a mint, `mintBlockOf + 2` may still be in the
 * future. In that case the token is not yet final — we return the raw seed with
 * `pending: true` so callers can retry / show a "pending" state instead of
 * rendering the wrong traits. This is the documented, simple handling.
 */

/** Blocks between a mint and the block whose hash seeds its art (core SEED_DELAY_BLOCKS). */
export const SEED_DELAY_BLOCKS = 2n;

/** The block whose hash supplies display entropy for a token minted in `mintBlock`. */
export function entropyBlockFor(mintBlock: bigint): bigint {
  return mintBlock + SEED_DELAY_BLOCKS;
}

/**
 * Pure display-seed derivation. `entropyBlockHash` must be the hash of block
 * `mintBlock + SEED_DELAY_BLOCKS`. Claim tokens (`mintBlock === 0`) keep their
 * deterministic seed untouched.
 */
export function deriveDisplaySeed(
  seedOf: Hex,
  mintBlock: bigint,
  entropyBlockHash: Hex,
): Hex {
  if (mintBlock === 0n) return seedOf;
  return keccak256(concatHex([seedOf, entropyBlockHash]));
}

export type DisplaySeedResult = {
  /** Raw `seedOf[id]` — the work hash / claim hash / craft pre-seed. */
  seedOf: Hex;
  /** `mintBlockOf[id]` — 0 for claim tokens. */
  mintBlock: bigint;
  /** Post-inclusion seed used for traits / rarity / art. */
  displaySeed: Hex;
  /** True while `mintBlockOf + 2` is not yet mined (display seed not final). */
  pending: boolean;
};

/**
 * Read `seedOf[id]` + `mintBlockOf[id]` and derive the display seed, freshly
 * reading `blockhash(mintBlockOf + 2)` via viem. Used by the server routes and
 * the client pages so every consumer shares one derivation.
 */
export async function readDisplaySeed(
  client: PublicClient,
  tokenId: bigint,
  contractAddress: Address = getAddress(CONTRACT_ADDRESS),
): Promise<DisplaySeedResult> {
  const [seedOf, mintBlock] = await Promise.all([
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "seedOf",
      args: [tokenId],
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "mintBlockOf",
      args: [tokenId],
    }),
  ]);

  // Claim tokens (and any token predating v3.4) keep the deterministic seed.
  if (mintBlock === 0n) {
    return { seedOf, mintBlock, displaySeed: seedOf, pending: false };
  }

  const entropyBlock = entropyBlockFor(mintBlock);
  const head = await client.getBlockNumber();
  if (head < entropyBlock) {
    // Not yet final — caller may retry; expose raw seed with `pending: true`.
    return { seedOf, mintBlock, displaySeed: seedOf, pending: true };
  }

  const block = await client.getBlock({ blockNumber: entropyBlock });
  if (!block.hash) {
    return { seedOf, mintBlock, displaySeed: seedOf, pending: true };
  }

  return {
    seedOf,
    mintBlock,
    displaySeed: deriveDisplaySeed(seedOf, mintBlock, block.hash),
    pending: false,
  };
}
