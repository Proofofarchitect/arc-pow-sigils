import type { Address } from "viem";
import { HOUSE_CARD_SLOTS } from "./traits";
import { ARC_TRAITS_SLOTS } from "./traits_v2";
import { IS_V2 } from "./traits-set";

/**
 * craft.ts — CraftingControllerV2 web surface (one-shot crafting).
 *
 * Mirrors `contracts/src/CraftingControllerV2.sol` byte-for-byte — do NOT guess
 * names or types. v2 replaces the v1 commit/reveal/refund flow with a SINGLE
 * payable `craft(cardA, cardB, choices, boostTier)` that escrows + burns both
 * cards and forges the child atomically. There is no commit, no reveal, no
 * refund, no salt and no entropy window: the child seed is a PRE-seed and the
 * final art seed is derived off-chain from a later block hash (post-inclusion
 * entropy, see `lib/display-seed.ts`).
 *
 * The HC/2 derivation itself lives in `lib/hc2.ts`; this module only carries the
 * controller ABI, the env address and the tier/fee/slot display helpers.
 */

/**
 * CraftingControllerV2 address on Arc testnet. Optional: when
 * NEXT_PUBLIC_CRAFT_ADDRESS is unset the controller has not been deployed yet
 * and `/craft` renders a clean "not deployed" state (no crash).
 */
export const CRAFT_ADDRESS: Address | null =
  (process.env.NEXT_PUBLIC_CRAFT_ADDRESS?.trim() as Address | undefined) || null;

/** True when a controller address is configured for this build. */
export function craftConfigured(): boolean {
  return CRAFT_ADDRESS !== null;
}

/**
 * BurnPoints address (v1.1). Optional: when NEXT_PUBLIC_POINTS_ADDRESS is
 * unset the `/craft` "Burn points" card is hidden and no `pointsOf` read is
 * attempted — the rest of the page still works.
 */
export const POINTS_ADDRESS: Address | null =
  (process.env.NEXT_PUBLIC_POINTS_ADDRESS?.trim() as Address | undefined) || null;

/** True when a BurnPoints address is configured for this build. */
export function pointsConfigured(): boolean {
  return POINTS_ADDRESS !== null;
}

/**
 * BurnPoints read surface (economy v1.1 spec §4). `pointsOf(wallet)` returns
 * the integer burn points accrued when the wallet's cards were burned in a
 * craft (rarity-weighted: 10…30 per parent by tier).
 */
export const BURNPOINTS_ABI = [
  {
    type: "function",
    name: "pointsOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ------------------------------------------------------------ constants

/** The only door in v2: CRAFT_2_1 (2 → 1). */
export const DOOR_CRAFT_2_1 = 0;
/** Highest selectable slot (0..11); legendary (12) is always entropy-derived. */
export const MAX_SLOT = 11;
/** Highest boost tier usable (tier 4 reserved for season-2 doors). */
export const MAX_BOOST_TIER = 3;
/** Free tokens are non-transferable below wave 5 (LOCK_WAVES). */
export const LOCK_WAVES = 5n;
/** Fixed base craft fee (5 USDC, 18-dec native). Mirrors `CRAFT_FEE`. */
export const CRAFT_FEE = 5n * 10n ** 18n;

// ------------------------------------------------------------------- tiers

export type CraftTier = {
  /** On-chain tier index 0..3 (uint8). */
  id: number;
  /** Short label used in lists. */
  label: string;
  /** Human display name. */
  name: string;
  /** min(6 + 2·tier, 12) — mirrors the controller's `maxChosen`. */
  maxChosen: number;
  /** Human note on the boost premium at this tier. */
  boostNote: string;
};

/**
 * Tier table — `maxChosen = min(6 + 2·tier, 12)`. Boost cost on-chain:
 * tier 0 → 0; tier ≥ 1 → `0.5 × price × 2^(tier−1)` (read live via `boostCost`).
 */
export const CRAFT_TIERS: readonly CraftTier[] = [
  {
    id: 0,
    label: "t0",
    name: "No boost (tier 0)",
    maxChosen: 6,
    boostNote: "no boost — 6 inherited slots",
  },
  {
    id: 1,
    label: "t1",
    name: "Tier 1",
    maxChosen: 8,
    boostNote: "boost 0.5×price — 8 slots",
  },
  {
    id: 2,
    label: "t2",
    name: "Tier 2",
    maxChosen: 10,
    boostNote: "boost 1×price — 10 slots",
  },
  {
    id: 3,
    label: "t3",
    name: "Tier 3",
    maxChosen: 12,
    boostNote: "boost 2×price — 12 slots (max control)",
  },
];

/** Tier by on-chain index, or undefined for an out-of-range value. */
export function tierById(id: number): CraftTier | undefined {
  return CRAFT_TIERS[id];
}

/** Tier label (falls back to "tier N" for junk values). */
export function tierLabel(id: number): string {
  return tierById(id)?.label ?? `tier ${id}`;
}

/** Mirror of the controller `maxChosen(tier)` = `min(6 + 2·tier, 12)`. */
export function tierMaxChosen(tier: number): number {
  return Math.min(6 + 2 * tier, 12);
}

// --------------------------------------------------------------- slot names

/**
 * Human-readable names of the 12 choice-able slots (indices 0..11), in slot
 * order — house-card/1: background…companion; ARC-traits/2: background…origin.
 * Indices 12/13/14 are always entropy-derived and excluded. Derived from the
 * active trait set (RT-3) so the UI never drifts from the derivation.
 */
export const CHOICE_SLOT_NAMES: readonly string[] = (
  IS_V2 ? ARC_TRAITS_SLOTS : HOUSE_CARD_SLOTS
)
  .slice(0, 12)
  .map((slot) => slot.name);

/**
 * All 15 slot names for the active trait set, in roll order — the display set
 * for the post-forge trait chips.
 */
export const CRAFTED_SLOT_NAMES: readonly string[] = (
  IS_V2 ? ARC_TRAITS_SLOTS : HOUSE_CARD_SLOTS
).map((slot) => slot.name);

/** Display label for a slot index (title-cased; falls back to `slot N`). */
export function slotLabel(index: number): string {
  const name = CHOICE_SLOT_NAMES[index];
  if (!name) return `slot ${index}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** One inherited slot: `parent` is 0 (cardA) or 1 (cardB); `slot` is 0..11. */
export type SlotChoice = { slot: number; parent: 0 | 1 };

// ---------------------------------------------------------------------- ABI

/**
 * CraftingControllerV2 ABI — verbatim from
 * `contracts/src/CraftingControllerV2.sol`.
 */
export const CONTROLLER_ABI = [
  // --- write ---
  {
    type: "function",
    name: "craft",
    stateMutability: "payable",
    inputs: [
      { name: "cardA", type: "uint256" },
      { name: "cardB", type: "uint256" },
      {
        name: "choices",
        type: "tuple[]",
        components: [
          { name: "slot", type: "uint8" },
          { name: "parent", type: "uint8" },
        ],
      },
      { name: "boostTier", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawFees",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "paused_", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "acceptOwnership",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  // --- fees / params ---
  {
    type: "function",
    name: "craftFee",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "boostCost",
    stateMutability: "view",
    inputs: [{ name: "tier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeFor",
    stateMutability: "view",
    inputs: [{ name: "tier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxChosen",
    stateMutability: "pure",
    inputs: [{ name: "tier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalFeesCollected",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // --- public constants ---
  {
    type: "function",
    name: "DOOR_CRAFT_2_1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "MAX_SLOT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "MAX_BOOST_TIER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "LOCK_WAVES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "CRAFT_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // --- views ---
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "craftNonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "nft",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
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
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "points",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  // --- events ---
  {
    type: "event",
    name: "Crafted",
    inputs: [
      { name: "childId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "cardA", type: "uint256", indexed: false },
      { name: "cardB", type: "uint256", indexed: false },
      { name: "childSeed", type: "bytes32", indexed: false },
      { name: "boostTier", type: "uint8", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesWithdrawn",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PausedSet",
    inputs: [{ name: "paused", type: "bool", indexed: false }],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferStarted",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
    ],
  },
] as const;

/**
 * Minimal extra reads on the CORE House Card contract that the /craft page
 * needs but which are not part of `POW_MINT_NFT_ABI` (contract.ts): the forge
 * pause flag and the free-token mirror.
 */
export const CORE_CRAFT_ABI = [
  {
    type: "function",
    name: "forgePaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isFreeToken",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
