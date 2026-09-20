import { decodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import type { RarityTier } from "./rarity";

/**
 * staking.ts — StakingVault v1 web surface (Phase 2, stream B).
 *
 * Frozen spec: staking spec §2 (tiers) and §3 (state/API). This module is
 * the single source of truth for the vault ABI, the tier table, and the small
 * amount of display math the `/stake` page needs. It mirrors the on-chain
 * contract byte-for-byte — do NOT guess names or types.
 */

/**
 * StakingVault address on Arc testnet. Optional: when
 * NEXT_PUBLIC_VAULT_ADDRESS is unset the vault has not been deployed yet and
 * the `/stake` page renders a clean "not deployed" state (no crash).
 */
export const VAULT_ADDRESS: Address | null =
  (process.env.NEXT_PUBLIC_VAULT_ADDRESS?.trim() as Address | undefined) || null;

/** True when a vault address is configured for this build. */
export function vaultConfigured(): boolean {
  return VAULT_ADDRESS !== null;
}

/**
 * RarityRegistry address (v1.1). Optional: when
 * NEXT_PUBLIC_REGISTRY_ADDRESS is unset no card carries an attested rarity
 * tier yet and `/stake` shows every card as Standard (bps 10000) — no crash.
 */
export const REGISTRY_ADDRESS: Address | null =
  (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS?.trim() as Address | undefined) ||
  null;

/** True when a RarityRegistry address is configured for this build. */
export function registryConfigured(): boolean {
  return REGISTRY_ADDRESS !== null;
}

/**
 * StakeRewards address (v1.1). Optional: when NEXT_PUBLIC_REWARDS_ADDRESS is
 * unset the `/stake` Rewards panel is hidden and no `pendingOf`/`claim` tx is
 * ever attempted — the rest of the page still works.
 */
export const REWARDS_ADDRESS: Address | null =
  (process.env.NEXT_PUBLIC_REWARDS_ADDRESS?.trim() as Address | undefined) ||
  null;

/** True when a StakeRewards address is configured for this build. */
export function rewardsConfigured(): boolean {
  return REWARDS_ADDRESS !== null;
}

/**
 * First N token ids correspond to the "influencer / free-claim" slots. Those
 * tokens carry the core's free-token lock (non-transferable until wave ≥ 5,
 * LOCK_WAVES), so the vault's `transferFrom` reverts — they cannot be staked
 * until then. Used only to enrich the error message (staking spec §9).
 */
export const FREE_TOKEN_MAX_ID = 42n;

/** Core discount cap (MAX_DISCOUNT_BITS in PowMintNFTv3_1). */
export const MAX_DISCOUNT_BITS = 6;

/** One staking tier. `weightX10` is the integer (×10) pool weight from §2. */
export type StakeTier = {
  /** On-chain tier index 0..5 (uint8). */
  id: number;
  /** Short label used in lists — flexible/7d/30d/90d/180d/365d. */
  label: string;
  /** Human display name. */
  name: string;
  /** Lock period in days (0 = flexible). */
  lockDays: number;
  /** Weight ×10 (integer, no float) — pool accounting v1.1. */
  weightX10: number;
  /** PoW-discount grant, in bits (2/4/6). */
  bits: number;
};

/**
 * Tier table — staking spec.md §2 (frozen):
 * | tier | lock          | weight | ×10 | bits |
 * | 0    | flexible (0d) | 0.1×   | 1   | 2    |
 * | 1    | 7 days        | 0.5×   | 5   | 2    |
 * | 2    | 30 days       | 1.0×   | 10  | 4    |
 * | 3    | 90 days       | 2.0×   | 20  | 4    |
 * | 4    | 180 days      | 3.0×   | 30  | 6    |
 * | 5    | 365 days      | 4.0×   | 40  | 6    |
 */
export const STAKE_TIERS: readonly StakeTier[] = [
  { id: 0, label: "flexible", name: "Flexible (0 days)", lockDays: 0, weightX10: 1, bits: 2 },
  { id: 1, label: "7d", name: "7 days", lockDays: 7, weightX10: 5, bits: 2 },
  { id: 2, label: "30d", name: "30 days", lockDays: 30, weightX10: 10, bits: 4 },
  { id: 3, label: "90d", name: "90 days", lockDays: 90, weightX10: 20, bits: 4 },
  { id: 4, label: "180d", name: "180 days", lockDays: 180, weightX10: 30, bits: 6 },
  { id: 5, label: "365d", name: "365 days", lockDays: 365, weightX10: 40, bits: 6 },
];

/** Tier by on-chain index, or undefined for an out-of-range value. */
export function tierById(id: number): StakeTier | undefined {
  return STAKE_TIERS[id];
}

/** Short label for a tier index (falls back to "tier N" for junk values). */
export function tierLabel(id: number): string {
  return tierById(id)?.label ?? `tier ${id}`;
}

const SECONDS_PER_DAY = 86_400n;

/**
 * Lock end (unix seconds) for a stake: stakedAt + lockDays·86400.
 *
 * Hard-lock model (owner decision 2026-09-18): the card stays in the vault until
 * this timestamp — there is NO early exit. `lockEnd` is exactly the value the
 * vault's `unstake` checks against (`Locked(until)` reverts while now < lockEnd).
 */
export function unlockAt(stakedAtSec: bigint, lockDays: number): bigint {
  return stakedAtSec + BigInt(lockDays) * SECONDS_PER_DAY;
}

/** True while `nowSec` is still before the tier's lock end (card cannot exit). */
export function isLocked(
  stakedAtSec: bigint,
  lockDays: number,
  nowSec: number,
): boolean {
  return BigInt(nowSec) < unlockAt(stakedAtSec, lockDays);
}

/** Render a unix-seconds timestamp as a UTC `YYYY-MM-DD` date (deterministic). */
export function formatUnixDate(tsSec: bigint | number): string {
  const ms = Number(tsSec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

const MONTHS_UTC = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Render a unix-seconds timestamp as `DD Mon HH:MM UTC` (deterministic). */
export function formatUnixDateTime(tsSec: bigint | number): string {
  const ms = Number(tsSec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = MONTHS_UTC[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd} ${mon} ${hh}:${mm} UTC`;
}

// ---------------------------------------------------------------- rarity v1.1

/** bps denominator for the rarity multiplier (rarity notes §2 / economy v1.1 spec §1). */
export const RARITY_BPS_DENOM = 10_000;

/**
 * One registry rarity tier. `bps` is the on-chain weight multiplier ×10000:
 * Standard 10000 · Notable 12000 · Rare 16000 · Epic 22000 · Mythic 30000
 * (economy v1.1 spec §1). `multiplier` is the human ×N form.
 */
export type RarityTierInfo = {
  /** On-chain tier index 0..4 (uint8). */
  id: number;
  /** Label shared with the rarity showcase (`lib/rarity.ts`). */
  label: RarityTier;
  /** bps multiplier (BPS_DENOM = 10000). */
  bps: number;
  /** Human "1.0×"…"3.0×". */
  multiplier: string;
  /** CSS class from globals.css (`.tier-*`, shared with the showcase). */
  className: string;
};

/** Registry tier table — economy v1.1 spec §1 (frozen). */
export const RARITY_TIERS: readonly RarityTierInfo[] = [
  { id: 0, label: "Standard", bps: 10_000, multiplier: "1.0×", className: "tier-standard" },
  { id: 1, label: "Notable", bps: 12_000, multiplier: "1.2×", className: "tier-notable" },
  { id: 2, label: "Rare", bps: 16_000, multiplier: "1.6×", className: "tier-rare" },
  { id: 3, label: "Epic", bps: 22_000, multiplier: "2.2×", className: "tier-epic" },
  { id: 4, label: "Mythic", bps: 30_000, multiplier: "3.0×", className: "tier-mythic" },
];

/** Registry tier by on-chain index, or undefined for an out-of-range value. */
export function rarityTierById(id: number): RarityTierInfo | undefined {
  return RARITY_TIERS[id];
}

/** Rarity label for a tier index — defaults to "Standard" for junk/unset. */
export function rarityLabel(id: number): RarityTier {
  return rarityTierById(id)?.label ?? "Standard";
}

/** bps multiplier for a tier index — defaults to 10000 (Standard) for junk. */
export function rarityBps(id: number): number {
  return rarityTierById(id)?.bps ?? RARITY_BPS_DENOM;
}

/** CSS class (globals.css `.tier-*`) for a tier index; Standard on junk. */
export function rarityTierClass(id: number): string {
  return rarityTierById(id)?.className ?? "tier-standard";
}

/**
 * Registry key for a token id: `bytes32(uint256(tokenId))` (economy v1.1 spec
 * §1 frozen correction). Encode a uint256 token id as a left-zero-padded
 * 32-byte key for `tierOf`/`tierOfKey`/`bpsOf`.
 */
export function tokenKey(tokenId: bigint): Hex {
  return toHex(tokenId, { size: 32 });
}

/**
 * Per-card stake weight ×10: `lockWeightX10(tier) × bps(rarity) / 10000`
 * (integer, economy v1.1 spec §2). Mirrors the vault's `weightOf` summation term so
 * the UI can show a per-card contribution without an extra read.
 */
export function cardWeightX10(lockTier: number, rarityTier: number): number {
  const lock = tierById(lockTier)?.weightX10 ?? 0;
  return Math.floor((lock * rarityBps(rarityTier)) / RARITY_BPS_DENOM);
}

/**
 * StakingVault v1 ABI — verbatim from staking spec.md §3 (hard-lock revision).
 * `stakeInfo` is a public mapping of a struct, so its getter exposes the five
 * fields in declaration order (owner, tier, stakedAt, accrued, lastAccrual).
 *
 * Hard lock (owner decision 2026-09-18): `unstake` reverts `Locked(uint64)`
 * until `stakedAt + lockDays(tier)·86400`. There is no `emergencyUnstake` and no
 * re-stake cooldown (`reStakeUnlockAt`/`InCooldown` were removed).
 */
export const VAULT_ABI = [
  // --- write ---
  {
    type: "function",
    name: "stake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "tier", type: "uint8" },
    ],
    outputs: [],
  },
  {
    // Hard lock: reverts Locked(until) while now < stakedAt + lockDays(tier)·DAY.
    type: "function",
    name: "unstake",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "acceptOwnership",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  // --- views ---
  {
    type: "function",
    name: "stakeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "nft",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    // Hard-lock term (days) for a tier — on-chain source of truth for lockEnd.
    // tier 0 => 0 (flexible); matches STAKE_TIERS above.
    type: "function",
    name: "lockDays",
    stateMutability: "pure",
    inputs: [{ name: "tier", type: "uint8" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "pendingOwner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "stakesOf",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "stakeInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "tier", type: "uint8" },
      { name: "stakedAt", type: "uint64" },
      { name: "accrued", type: "uint64" },
      { name: "lastAccrual", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "accruedOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    // v1.1: Σ (lockWeightX10 × bpsOf(tokenKey) / 10000) over the wallet's stakes.
    type: "function",
    name: "weightOf",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // --- errors ---
  {
    // Hard lock: `unstake` reverts while block.timestamp < stakedAt + lockDays·DAY.
    type: "error",
    name: "Locked",
    inputs: [{ name: "until", type: "uint64" }],
  },
  // --- events (for indexing/monitoring) ---
  {
    type: "event",
    name: "Staked",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "tier", type: "uint8", indexed: false },
      { name: "bits", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unstaked",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "penalized", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PenaltyApplied",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "removed", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BoostSet",
    inputs: [
      { name: "wallet", type: "address", indexed: true },
      { name: "bits", type: "uint8", indexed: false },
    ],
  },
] as const;

/** 4-byte selector of the vault's `Locked(uint64)` custom error. */
const LOCKED_SELECTOR = keccak256(toHex("Locked(uint64)"))
  .slice(0, 10)
  .toLowerCase();

/** Pull raw revert bytes out of a viem error chain (or a bare `.data`). */
function extractRevertData(err: unknown): Hex | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    data?: unknown;
    walk?: (predicate: (frame: unknown) => boolean) => unknown;
    info?: { error?: { data?: unknown } };
  };
  const isHex = (v: unknown): v is Hex =>
    typeof v === "string" && v.startsWith("0x");
  if (typeof e.walk === "function") {
    const hit = e.walk((frame) => isHex((frame as { data?: unknown })?.data)) as
      | { data?: unknown }
      | undefined;
    if (hit && isHex(hit.data)) return hit.data;
  }
  if (isHex(e.data)) return e.data;
  if (isHex(e.info?.error?.data)) return e.info?.error?.data ?? null;
  return null;
}

/**
 * Decode a `Locked(uint64 until)` revert into the unix-seconds unlock time.
 * Returns null when the error is not a Locked revert. Handles both the raw
 * ABI-encoded revert data (viem error chain) and viem's decoded error text.
 */
export function decodeLockedError(err: unknown): bigint | null {
  const data = extractRevertData(err);
  if (data && data.length >= 10 && data.slice(0, 10).toLowerCase() === LOCKED_SELECTOR) {
    try {
      const [until] = decodeAbiParameters(
        [{ type: "uint64" }],
        `0x${data.slice(10)}` as Hex,
      );
      if (typeof until === "bigint") return until;
    } catch {
      // fall through to the textual probe
    }
  }
  // viem decodes custom errors against the ABI, so the message can carry the
  // decode; probe for a bare Locked(<digits>) as a last resort.
  const message = err instanceof Error ? err.message : "";
  const m = /Locked\(\s*(\d+)\s*\)/.exec(message);
  return m ? BigInt(m[1]) : null;
}

/**
 * Human message for a `Locked` revert — e.g. "Card is locked until 25 Sep 14:30
 * UTC" — or null when the error is not a Locked revert (so callers can fall back
 * to a generic humanizer).
 */
export function humanizeLockedError(err: unknown): string | null {
  const until = decodeLockedError(err);
  return until === null
    ? null
    : `Card is locked until ${formatUnixDateTime(until)}`;
}

/**
 * Minimal ERC-721 approval surface, read/written against the CORE House Card
 * contract (POW_MINT_NFT_ABI already carries `ownerOf`). The stake flow calls
 * `getApproved` then `approve(vault, tokenId)` before `stake`.
 */
export const ERC721_APPROVAL_ABI = [
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  // Operator approvals — used by /craft to cover BOTH cards with a single
  // setApprovalForAll tx instead of one approve() per card.
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/**
 * RarityRegistry read surface (economy v1.1 spec §1, frozen).
 *
 * The key is `bytes32(uint256(tokenId))`; `tierOf` is the public-mapping getter
 * for the card's tier (0..4) and `bpsOf` returns the ×10000 weight multiplier
 * (10000 default for an un-attested card). Mirrors
 * `contracts/src/RarityRegistry.sol`.
 */
export const REGISTRY_ABI = [
  {
    type: "function",
    name: "tierOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "bpsOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint16" }],
  },
] as const;

/**
 * StakeRewards surface (economy v1.1 spec §3). `pendingOf` reads the
 * currently-claimable native-USDC amount for a wallet; `claim()` pays it out.
 */
export const REWARDS_ABI = [
  {
    type: "function",
    name: "pendingOf",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;
