import type { Address } from "viem";

/**
 * canonical.ts — SINGLE SOURCE OF TRUTH for the deployed contract address set.
 *
 * Current canon: **v3.4** on Arc mainnet (chainId 5042, deployed 2026-09-21).
 * The testnet v3.4 stack (0x8f57…/0xb193…/0x5F7f…/0x9Ce1…/0x5939…/0xD964…) is superseded.
 *
 * Rules:
 *  - Do NOT hardcode any of these addresses elsewhere in the repo. Import the
 *    constants from this module (code) or reference them in docs/env.
 *  - The gate `web/scripts/check-addresses.mjs` (npm run check:addresses) parses
 *    THIS file for the canonical set and FAILS the build if any other 40-hex
 *    address appears in an active source/doc file. Add a new address here first.
 *  - On redeploy: bump CANON_VERSION, update the addresses below, then rerun
 *    the gate + all `check:*` parity gates.
 */

/** Current deployed contract stack version. */
export const CANON_VERSION = "v3.4";

/** Arc chain id (env-driven): 5042002 testnet · 5042 mainnet. */
export const CANON_CHAIN_ID: number = Number(
  process.env.NEXT_PUBLIC_ARC_CHAIN_ID?.trim() || 5042002,
);

/** PowMintNFT core (v3.4) — keccak-PoW mint, claims, waves, forge/burn. */
export const CANON_CORE: Address = "0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4";

/** StakingVaultV2 (v3.4) — hard-lock vault, milli-bit PoW boost. */
export const CANON_VAULT: Address = "0xEa9dD5BD05922878A93e2F67bd457D2bBad5BE83";

/** CraftingControllerV2 (v3.4) — one-shot 2→1 craft (no commit/reveal). */
export const CANON_CRAFT: Address = "0xb7f32811F19579D9FC6F0e5ac925473554091a91";

/** RarityRegistry (mainnet deploy 2026-09-21). */
export const CANON_REGISTRY: Address = "0x09699f496572a4288b0d9e3b436936f89142624b";

/** StakeRewards (mainnet deploy 2026-09-21) — streams USDC to stakers by weight. */
export const CANON_REWARDS: Address = "0xbe1bb857d3653beacd2f56e395b1ada3f4f4a49e";

/** BurnPoints (mainnet deploy 2026-09-21). */
export const CANON_POINTS: Address = "0x7bb5fa517745302b1d44eac458f55c1eeb6675b5";

/** First block of the v3.4 stack (earliest known v3.4 deploy tx) — log scan floor. */
export const CANON_FROM_BLOCK = 22030776;

/** Block the v3.4 CraftingControllerV2 was deployed at (craft log scan floor). */
export const CANON_CRAFT_FROM_BLOCK = 22030850;
