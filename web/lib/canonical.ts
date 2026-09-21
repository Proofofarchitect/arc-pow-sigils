import type { Address } from "viem";

/**
 * canonical.ts — SINGLE SOURCE OF TRUTH for the deployed contract address set.
 *
 * Current canon: **v3.4** on Arc testnet (chainId 5042002).
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
export const CANON_CORE: Address = "0x8f5795343C10b316296f6767a10e87CC40E62491";

/** StakingVaultV2 (v3.4) — hard-lock vault, milli-bit PoW boost. */
export const CANON_VAULT: Address = "0xb19391b0Ce967f473665691295F2846C424c720a";

/** CraftingControllerV2 (v3.4) — one-shot 2→1 craft (no commit/reveal). */
export const CANON_CRAFT: Address = "0x5F7f7D3E641D09565Cf6f81D461bA09910f6685F";

/** RarityRegistry (reused from the v1.1 economy deploy). */
export const CANON_REGISTRY: Address = "0x9Ce1cD8d4Bdcba89A2be6E0021FD073DDDa3CD47";

/** StakeRewards (reused) — streams USDC to stakers by weight. */
export const CANON_REWARDS: Address = "0x593973Ce94A82282a7d6f4bbf384CCd852d160a1";

/** BurnPoints (reused). */
export const CANON_POINTS: Address = "0xD964C910DDa776Da55A900F85b019f48C237EA8b";

/** First block of the v3.4 stack (earliest known v3.4 deploy tx) — log scan floor. */
export const CANON_FROM_BLOCK = 63236723;

/** Block the v3.4 CraftingControllerV2 was deployed at (craft log scan floor). */
export const CANON_CRAFT_FROM_BLOCK = 63236726;
