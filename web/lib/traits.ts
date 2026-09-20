import { concatHex, keccak256, type Hex } from "viem";
import { weightedPickFromSeed } from "./prng";

/**
 * House Card trait factory — full 15-slot derivation.
 *
 * This is a byte-for-byte semantic port of `art/pipeline.py` (the canonical
 * art-side implementation). The machine-readable contract is `art/spec.json`
 * (slot order, integer weights ×10 summing 1000/slot, render order, golden/bug
 * rules) and `art/test_vectors.json` (5 seeds × 15 slots — the cross-check
 * contract). `scripts/check-traits.mjs` asserts parity against those vectors.
 *
 * Derivation (matches `lib/prng.ts`, counter reset per slot):
 *   h = keccak256( seed_bytes32 ‖ uint8(slotIndex) ‖ uint16(repeatCounter) )
 * `h` is read as sixteen big-endian uint16 words; modulo bias is removed with
 * rejection sampling; the per-slot counter resets to 0.
 *
 * Replaces the previous placeholder "Grid Sigils" system
 * (Faction/Body/Core/Aura).
 */

/** The `None` sentinel used by face/headwear/quote/lore/companion/legendary/golden. */
export const NONE = "None";

/**
 * Golden threshold: 3% of the 16-bit space. Success when a raw uint16 word is
 * strictly below this value (~ floor(0.03 · 65536) = 1966).
 */
export const GOLDEN_THRESHOLD = 1966;

/**
 * Golden checks, evaluated in this exact order (first success wins). A check
 * only runs — and only consumes one raw uint16 word from the golden stream
 * (slot index 13) — when its prerequisite is met. Mirrors the short-circuit
 * `and` in the the v1 mechanics doc.md §3 pseudocode.
 */
export const GOLDEN_CHECKS: readonly {
  event: string;
  slot: string;
  value: string;
}[] = [
  { event: "House Cat", slot: "companion", value: "House Cat" },
  { event: "Fat Rat", slot: "companion", value: "Fat Rat" },
];

/** Render order for PNG composition (metadata-only slots are excluded). */
export const RENDER_ORDER: readonly string[] = [
  "background",
  "body",
  "outfit",
  "face",
  "eyes",
  "headwear",
  "tool",
  "companion",
  "bug",
  "legendary",
];

/** Metadata-only slots — rendered as text rows, never pixels. */
export const METADATA_ONLY_SLOTS: readonly string[] = [
  "era",
  "origin",
  "quote",
  "lore",
];

type SlotDef = {
  name: string;
  /** PRNG slot index (roll position; a uint8). */
  index: number;
  values: readonly string[];
  /** Integer weights (×10, sum 1000 per weighted slot); null for golden. */
  weights: readonly number[] | null;
};

/**
 * All 15 slots in roll order. Weights are the spec's integer weights (×10
 * scale, units of 0.1%). `golden` (index 13) is a conditional override, not a
 * weighted slot (weights = null).
 */
export const HOUSE_CARD_SLOTS: readonly SlotDef[] = [
  {
    name: "background",
    index: 0,
    values: [
      "House Grid",
      "Testnet Grid",
      "Discord #dev",
      "Faucet Screen",
      "Blueprint",
      "Block 0",
      "Mainnet Blue",
      "Validator Wall",
      "Istanbul Night",
      "Singapore Office",
      "NYC Launch",
      "404",
    ],
    weights: [140, 130, 120, 100, 90, 80, 80, 70, 60, 50, 50, 30],
  },
  {
    name: "body",
    index: 1,
    values: ["Builder Frame", "Clerk Frame", "Architect Frame", "Shadow Frame"],
    weights: [350, 300, 220, 130],
  },
  {
    name: "outfit",
    index: 2,
    values: [
      "House Hoodie",
      "Teller Vest",
      "Blueprint Coat",
      "DevRel Jacket",
      "LinkedIn Armor",
      "Privacy Cloak",
      "Validator Suit",
      "Day One Sash",
    ],
    weights: [220, 180, 150, 130, 110, 90, 70, 50],
  },
  {
    name: "face",
    index: 3,
    values: ["None", "Tired Builder"],
    weights: [950, 50],
  },
  {
    name: "eyes",
    index: 4,
    values: [
      "Default",
      "USDC Lenses",
      "Explorer 404",
      "Finality Eyes",
      "Spectacles",
      "Blank Visor",
    ],
    weights: [368, 165, 101, 55, 183, 128],
  },
  {
    name: "headwear",
    index: 5,
    values: [
      "None",
      "House Cap",
      "Office Headphones",
      "Reverse Cap 404",
      "Muted Hood",
      "Bandana",
      "Kippah",
      "500-Point Halo",
    ],
    weights: [370, 150, 120, 110, 90, 60, 50, 50],
  },
  {
    name: "era",
    index: 6,
    values: [
      "Testnet",
      "Day One",
      "House",
      "Pre-Testnet",
      "Announcement",
      "Private Mainnet",
    ],
    weights: [380, 200, 160, 120, 90, 50],
  },
  {
    name: "origin",
    index: 7,
    values: [
      "Community",
      "Discord Queue",
      "Testnet Wanderer",
      "Arc House",
      "LinkedIn Form",
      "Partner",
      "Validator Desk",
      "Circle",
    ],
    weights: [260, 200, 160, 120, 100, 80, 50, 30],
  },
  {
    name: "quote",
    index: 8,
    values: [
      "None",
      "Pending or Final",
      "Points have no monetary value",
      "Fees in the dollar",
      "The queues are too slow",
      "Architects are not employees",
      "Economic OS for the internet",
      "500 points",
      "USDC is cool",
      "Burn, attest, mint",
      "Türkiye, chapter one",
      "I'm seated, Tim",
      "More consequential than USDC",
    ],
    weights: [450, 80, 70, 70, 60, 60, 50, 40, 40, 30, 20, 20, 10],
  },
  {
    name: "lore",
    index: 9,
    values: [
      "None",
      "Discord not linked",
      "Faucet sent zero",
      "499 points then sleep",
      "Wrong chain id 5042/5042002",
      "Minted while cats were live",
      "First sub-second FINAL",
      "Waited until Silence opened posts",
    ],
    weights: [550, 100, 90, 80, 70, 50, 40, 20],
  },
  {
    name: "tool",
    index: 10,
    values: [
      "Faucet",
      "Terminal",
      "Compass",
      "USDC Coin",
      "Office Hours Mic",
      "Wrong Chain ID",
      "Bridge Kit",
      "18 Decimals",
      "Circle CLI",
      "Stamp FINAL",
    ],
    weights: [180, 160, 130, 120, 100, 90, 80, 70, 50, 20],
  },
  {
    name: "companion",
    index: 11,
    values: [
      "None",
      "House Cat",
      "Empty Faucet",
      "Cool Dollar",
      "Bean Cat",
      "Agent Drone",
      "Malachite Beetle",
      "Circle Bat",
      "Golden Fly",
      "Fat Rat",
    ],
    weights: [390, 180, 140, 110, 80, 50, 25, 10, 10, 5],
  },
  {
    name: "legendary",
    index: 12,
    values: [
      "None",
      "Sept 16",
      "Gas is a Dollar",
      "Queues Open",
      "House Opens",
      "Testnet Genesis",
      "Economic OS",
      "10B Mint",
      "The Silence",
      "Jeremy Drop-in",
    ],
    weights: [910, 20, 16, 14, 12, 10, 8, 6, 3, 1],
  },
  {
    name: "golden",
    index: 13,
    values: ["None", "House Cat", "Fat Rat"],
    weights: null,
  },
  {
    name: "bug",
    index: 14,
    values: [
      "None",
      "Faucet Cooldown",
      "Queue Too Slow",
      "Role Pending",
      "RPC Down",
      "Wallet Not Indexing",
      "Faucet Empty",
      "Wrong RPC",
      "499 Points",
      "Native vs ERC-20 USDC",
      "Gasless But Broke",
      "Explorer 404",
    ],
    weights: [450, 90, 80, 80, 70, 60, 60, 40, 30, 20, 15, 5],
  },
];

export type DerivedAttribute = {
  /** Slot name (roll order), e.g. "background" or "golden". */
  slot: string;
  /** Trait value verbatim, including the "None" sentinel. */
  value: string;
};

export type DerivedAttributes = {
  /** All 15 slots, in roll order. */
  attributes: DerivedAttribute[];
  /** True when a golden event fired (golden slot value != "None"). */
  golden: boolean;
};

/**
 * Optional derivation overrides. Used ONLY by preview mode (see `lib/preview.ts`)
 * — the canonical derivation (and every parity vector) uses the plain call.
 */
export type DeriveOptions = {
  /** Slot → values excluded from the weighted roll (their weight is forced to 0). */
  excludeValues?: Record<string, readonly string[]>;
  /** Force golden to "None" regardless of the roll. */
  disableGolden?: boolean;
};

/**
 * Raw 16-bit word stream for one slot, byte-identical to the Python
 * `uint16_stream`. Each digest yields sixteen big-endian uint16 words; the
 * counter starts at 0 and increments only after a digest is exhausted, so it is
 * implicitly reset for every slot (a fresh generator per slot).
 */
function* uint16Stream(seed: Hex, slotIndex: number): Generator<number> {
  for (let counter = 0; counter <= 0xffff; counter++) {
    const slotHex = slotIndex.toString(16).padStart(2, "0");
    const counterHex = counter.toString(16).padStart(4, "0");
    const digest = keccak256(
      concatHex([seed, `0x${slotHex}` as Hex, `0x${counterHex}` as Hex]),
    );

    for (let wordIndex = 0; wordIndex < 16; wordIndex++) {
      const offset = 2 + wordIndex * 4;
      yield Number.parseInt(digest.slice(offset, offset + 4), 16);
    }
  }

  throw new Error("uint16 counter exhausted while deriving an attribute");
}

function slotByName(name: string): SlotDef {
  const slot = HOUSE_CARD_SLOTS.find((candidate) => candidate.name === name);
  if (!slot) throw new Error(`Unknown House Card slot: ${name}`);
  return slot;
}

/**
 * Deterministically derives the full House Card trait set from a bytes32 seed,
 * exactly like `art/pipeline.py::derive`.
 *
 * Rules (the v1 mechanics doc.md §2/§3):
 * 1. Roll every weighted slot except `bug`; each slot resets its own counter.
 * 2. If `legendary != None` → golden and bug are both forced to "None".
 * 3. Else roll golden: sequential 3% checks in spec order (House Cat → Fat Rat)
 *    on raw uint16 words from the golden stream (index 13), one word per
 *    eligible check, first success wins.
 * 4. If golden hit → bug = "None". Else roll bug (index 14) normally.
 *
 * `options` (optional) applies preview-only overrides — see `lib/preview.ts`.
 */
export function deriveAttributes(
  seed: Hex,
  options?: DeriveOptions,
): DerivedAttributes {
  const values = new Map<string, string>();

  for (const slot of HOUSE_CARD_SLOTS) {
    if (slot.weights === null || slot.name === "bug") continue;

    let weights = slot.weights;
    const excluded = options?.excludeValues?.[slot.name];
    if (excluded && excluded.length > 0) {
      weights = weights.map((weight, i) =>
        excluded.includes(slot.values[i]) ? 0 : weight,
      );
    }

    // A fully zeroed slot (e.g. props off in preview mode) renders as "None".
    if (weights.every((weight) => weight === 0)) {
      values.set(slot.name, NONE);
      continue;
    }

    const index = weightedPickFromSeed(seed, slot.index, weights);
    values.set(slot.name, slot.values[index]);
  }

  const legendary = values.get("legendary")!;
  const headwear = values.get("headwear")!;
  const companion = values.get("companion")!;

  // Golden: only when legendary == "None" (and not disabled by overrides).
  let goldenValue = NONE;
  if (legendary === NONE && !options?.disableGolden) {
    const golden = slotByName("golden");
    const stream = uint16Stream(seed, golden.index);

    const prerequisites: Record<string, string> = { headwear, companion };
    for (const check of GOLDEN_CHECKS) {
      if (prerequisites[check.slot] !== check.value) continue;

      const word = stream.next().value as number;
      if (word < GOLDEN_THRESHOLD) {
        goldenValue = check.event;
        break;
      }
    }
  }
  values.set("golden", goldenValue);

  // Bug: only when legendary == "None" AND golden == false.
  let bugValue = NONE;
  if (legendary === NONE && goldenValue === NONE) {
    const bug = slotByName("bug");
    let weights = bug.weights!;
    const excluded = options?.excludeValues?.[bug.name];
    if (excluded && excluded.length > 0) {
      weights = weights.map((weight, i) =>
        excluded.includes(bug.values[i]) ? 0 : weight,
      );
    }
    if (weights.every((weight) => weight === 0)) {
      bugValue = NONE;
    } else {
      const index = weightedPickFromSeed(seed, bug.index, weights);
      bugValue = bug.values[index];
    }
  }
  values.set("bug", bugValue);

  return {
    attributes: HOUSE_CARD_SLOTS.map((slot) => ({
      slot: slot.name,
      value: values.get(slot.name)!,
    })),
    golden: goldenValue !== NONE,
  };
}

/** Convenience map (slot name → value) for the PNG renderer. */
export function attributeMap(derived: DerivedAttributes): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { slot, value } of derived.attributes) {
    map[slot] = value;
  }
  return map;
}

export type TraitAttribute = {
  trait_type: string;
  value: string;
};

/**
 * OpenSea-shaped `attributes`: every one of the 15 slots as
 * `{ trait_type: <slot>, value }` (values verbatim, including "None"), plus a
 * `{ trait_type: "Golden", value: "Yes" }` row only when a golden event fired.
 */
export function attributesForMetadata(
  derived: DerivedAttributes,
): TraitAttribute[] {
  const attributes: TraitAttribute[] = derived.attributes.map(
    ({ slot, value }) => ({
      trait_type: slot,
      value,
    }),
  );

  if (derived.golden) {
    attributes.push({ trait_type: "Golden", value: "Yes" });
  }

  return attributes;
}
