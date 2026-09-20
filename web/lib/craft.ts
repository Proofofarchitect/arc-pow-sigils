import {
  bytesToHex,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { HOUSE_CARD_SLOTS } from "./traits";
import { ARC_TRAITS_SLOTS } from "./traits_v2";
import { IS_V2 } from "./traits-set";

/**
 * craft.ts — CraftingController v1 web surface (Phase 2, stream C).
 *
 * Frozen spec: `HC/2 spec` v1 §3/§4 (controller surface) and §7 (web).
 * Mirrors `contracts/src/CraftingController.sol` byte-for-byte — do NOT guess
 * names or types. The HC/2 derivation itself lives in `lib/hc2.ts` (frozen API
 * owned by the derivation stream); this module only carries the controller ABI,
 * the env address, the tier/fee/window display helpers and the localStorage
 * persistence used to survive a page reload between commit and reveal.
 */

/**
 * CraftingController address on Arc testnet. Optional: when
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
 * craft reveal (rarity-weighted: 10…30 per parent by tier).
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

// ------------------------------------------------------------- window/time

/** `entropy = blockhash(commitBlock + 2)` (ENTROPY_DELAY, HC/2 spec §3). */
export const ENTROPY_DELAY = 2n;
/** Earliest reveal block offset `commitBlock + 3` (MIN_REVEAL_DELAY). */
export const MIN_REVEAL_DELAY = 3n;
/** Latest reveal block offset `commitBlock + 258` (REVEAL_WINDOW). */
export const REVEAL_WINDOW = 258n;
/** Highest selectable slot (0..11); legendary (12) is always entropy-derived. */
export const MAX_SLOT = 11;
/** Highest boost tier usable in v1 (tier 4 reserved for season-2 doors). */
export const MAX_BOOST_TIER = 3;
/** Free tokens are non-transferable below wave 5 (LOCK_WAVES). */
export const LOCK_WAVES = 5n;

export type CommitPhase = "waiting" | "reveal" | "closed" | "settled";

/**
 * Phase of a commit given the current block:
 *   waiting → `block < commit+3`  (entropy not yet available)
 *   reveal  → `commit+3 ≤ block ≤ commit+258`
 *   closed  → `block > commit+258` (only refund remains)
 */
export function revealWindowState(
  commitBlock: bigint,
  currentBlock: bigint,
  settled: boolean,
): CommitPhase {
  if (settled) return "settled";
  if (currentBlock < commitBlock + MIN_REVEAL_DELAY) return "waiting";
  if (currentBlock > commitBlock + REVEAL_WINDOW) return "closed";
  return "reveal";
}

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
 * Tier table — HC/2 spec §4 (frozen). `maxChosen = min(6 + 2·tier, 12)`.
 * Boost cost: tier 0 → 0; tier ≥ 1 → `0.5 × price × 2^(tier−1)`.
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
 * Indices 12/13/14 (v1 `legendary`/`golden`/`bug`, v2 `quote`/`lore`/
 * `hair_color`) are always entropy-derived and excluded. Derived from the active
 * trait set (RT-3) so the UI never drifts from the derivation.
 */
export const CHOICE_SLOT_NAMES: readonly string[] = (
  IS_V2 ? ARC_TRAITS_SLOTS : HOUSE_CARD_SLOTS
)
  .slice(0, 12)
  .map((slot) => slot.name);

/**
 * All 15 slot names for the active trait set, in roll order — the display set
 * for the post-reveal / Gacha trait chips. house-card/1: 12 choice-able +
 * `legendary`/`golden`/`bug`; ARC-traits/2: the full ARC slot list.
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

// ------------------------------------------------------ localStorage (F-16)

/** Prefix for the per-commit localStorage record (keyed by commitId, F-16). */
export const COMMIT_STORE_PREFIX = "poa.craft.commit.";

export type SlotChoice = { slot: number; parent: 0 | 1 };

// -------------------------------------------------------- commit hash + salt

/**
 * W3-01 fix: the frozen on-chain commit preimage is
 * `keccak256(abi.encode(SlotChoice[], salt))` — a client-side 32-byte secret
 * `salt` (bytes32) is mixed in so the public commit record is not
 * brute-forceable (a third party cannot force-settle a commit and deny the
 * committer's refund). The salt is never published in the commit tx (only the
 * resulting hash); it is stored locally with the choices and passed to
 * `reveal(commitId, choices, salt)`.
 */
export function encodeChoicesHash(choices: SlotChoice[], salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "slot", type: "uint8" },
            { name: "parent", type: "uint8" },
          ],
        },
        { type: "bytes32" },
      ],
      [choices, salt],
    ),
  );
}

/** A fresh 32-byte client secret (`crypto.getRandomValues`) as 0x-hex bytes32. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** True for a well-formed 0x-prefixed 32-byte hex salt. */
export function isSalt(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Persisted commit payload. `choices` are the SORTED (ascending slot) choices
 * actually hashed at commit — required to rebuild the reveal calldata. The
 * parent seeds (canonicalized: `seedLow` = smaller tokenId) are captured before
 * the parents are burned so the child can be previewed offline after reveal.
 */
export type StoredCommit = {
  commitId: string;
  player: string;
  cardA: string;
  cardB: string;
  tier: number;
  choices: SlotChoice[];
  /**
   * Client secret (bytes32) mixed into the committed hash (W3-01). Required to
   * reveal; optional in the type only so pre-upgrade records still parse.
   */
  salt?: Hex;
  seedLow: Hex;
  seedHigh: Hex;
  /** Filled in after a successful reveal (for the settled-panel preview). */
  childId?: string;
  childSeed?: Hex;
};

/** localStorage key for a commit id. */
export function commitStorageKey(commitId: bigint | string): string {
  return `${COMMIT_STORE_PREFIX}${commitId.toString()}`;
}

/** Persist (best-effort) the commit payload; silently no-ops off the browser. */
export function saveCommit(record: StoredCommit): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      commitStorageKey(record.commitId),
      JSON.stringify(record),
    );
  } catch {
    // storage disabled / quota — reveal from this browser will not be possible
  }
}

/** Load a persisted commit payload, or null when absent/corrupt (F-16). */
export function loadCommit(commitId: bigint | string): StoredCommit | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(commitStorageKey(commitId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCommit;
    if (!Array.isArray(parsed.choices)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------- ABI

/**
 * CraftingController v1 ABI — verbatim from `contracts/src/CraftingController.sol`.
 * `commits` is a public mapping of a struct, so its getter exposes the ten
 * fields in declaration order.
 */
export const CONTROLLER_ABI = [
  // --- write ---
  {
    type: "function",
    name: "commit",
    stateMutability: "payable",
    inputs: [
      { name: "cardA", type: "uint256" },
      { name: "cardB", type: "uint256" },
      { name: "slotChoicesHash", type: "bytes32" },
      { name: "boostTier", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reveal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitId", type: "uint256" },
      {
        name: "choices",
        type: "tuple[]",
        components: [
          { name: "slot", type: "uint8" },
          { name: "parent", type: "uint8" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitId", type: "uint256" }],
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
    stateMutability: "view",
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
    stateMutability: "view",
    inputs: [{ name: "tier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "committedFees",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // --- reveal/entropy window constants (public constants expose getters) ---
  {
    type: "function",
    name: "ENTROPY_DELAY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_REVEAL_DELAY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "REVEAL_WINDOW",
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
    name: "lastCommitId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "commits",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "player", type: "address" },
      { name: "cardA", type: "uint256" },
      { name: "cardB", type: "uint256" },
      { name: "choicesHash", type: "bytes32" },
      { name: "boostTier", type: "uint8" },
      { name: "nonce", type: "uint64" },
      { name: "commitBlock", type: "uint64" },
      { name: "fee", type: "uint256" },
      { name: "revealed", type: "bool" },
      { name: "refunded", type: "bool" },
    ],
  },
  // --- events ---
  {
    type: "event",
    name: "Committed",
    inputs: [
      { name: "commitId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "cardA", type: "uint256", indexed: false },
      { name: "cardB", type: "uint256", indexed: false },
      { name: "choicesHash", type: "bytes32", indexed: false },
      { name: "boostTier", type: "uint8", indexed: false },
      { name: "nonce", type: "uint64", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Crafted",
    inputs: [
      { name: "commitId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "cardA", type: "uint256", indexed: false },
      { name: "cardB", type: "uint256", indexed: false },
      { name: "childSeed", type: "bytes32", indexed: false },
      { name: "entropy", type: "bytes32", indexed: false },
      {
        name: "choices",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "slot", type: "uint8" },
          { name: "parent", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "commitId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "feeRefunded", type: "uint256", indexed: false },
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
 * pause flag (full-fee refund exception, RT-5) and the free-token mirror.
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

/** A single commit record as returned by the `commits(id)` getter. */
export type OnChainCommit = {
  player: Address;
  cardA: bigint;
  cardB: bigint;
  choicesHash: Hex;
  boostTier: number;
  nonce: bigint;
  commitBlock: bigint;
  fee: bigint;
  revealed: boolean;
  refunded: boolean;
};
