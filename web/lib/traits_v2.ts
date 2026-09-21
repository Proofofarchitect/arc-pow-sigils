import { weightedPickFromSeed } from "./prng";
import type { DerivedAttributes } from "./traits";
import type { Hex } from "viem";

/**
 * traits_v2.ts — ARC-traits/2 derivation (artist set, migration stage 3-4).
 *
 * Byte-for-byte semantic port of `art/arc-traits/tools/v2lib.py` on top of
 * `art/v2/spec.json`. The PRNG is UNCHANGED house-card/1 machinery
 * (`lib/prng.ts` / `art/pipeline.py` primitives): per-slot keccak256 word
 * streams + rejection-sampled weighted pick. v2 drops the golden/bug
 * conditional rules (the artist set has no such categories yet — new
 * categories will be appended as new slots, indices are append-only).
 *
 * The machine-readable cross-check contract is `art/v2/vectors_traits.json`
 * (5 seeds × 15 slots), asserted by `scripts/check-traits-v2.mjs`.
 *
 * Slot semantics (10 rendered image layers + 1 render modifier + 4 metadata-only):
 *   background, head, outfit, hair, eyes, nose, mouth, eyewear, headwear,
 *   companion, era, origin, quote, lore, hair_color
 * — `head` is the base character (replaces v1's body species), `outfit` is the
 * artist's garment layer (their `02_body`), `hair`/`nose`/`mouth`/`eyewear` are
 * first-class slots now. `hair_color` (index 14, spec v2.1) has no own layer —
 * it selects the hair asset (`hair-colors/<color>/<style>.png`, fallback
 * `hair/<style>.png`); for heads Ice/Pale/Reptile, nose/mouth resolve through
 * `head-variants/<head>/<slot>/<value>.png` when present (see renderer_v2.ts).
 *
 * Spec v2.2 (applied 2026-09-20): weight rebalance — chase tier <=1% (~75-150
 * copies at 15 042 supply, see weights rationale); era switched to the
 * mainnet palette (Genesis / Day One / Season One / House / Expansion / Private
 * Mainnet); origin "Testnet Wanderer" -> "Early Wanderer"; quote/lore values
 * unchanged.
 *
 * Spec v2.3 (2026-09-20, handoff-2026-09-20 "gold rare v2"): "+Gold Kippah"
 * (headwear) and "+Gold Fly" (companion) appended, 0.5% each (w5); "None"
 * rebalanced 34.0%->33.5% (headwear) / 33.0%->32.5% (companion); layer set
 * refreshed (centred halo + scene-fit backgrounds/eyewear/companions).
 */

/** Render order for PNG composition (artist zOrder: head UNDER clothing). */
export const V2_RENDER_ORDER: readonly string[] = [
  "background",
  "head",
  "outfit",
  "hair",
  "eyes",
  "nose",
  "mouth",
  "eyewear",
  "headwear",
  "companion",
];

/** Metadata-only slots (text rows, no pixels). */
export const V2_METADATA_ONLY_SLOTS: readonly string[] = [
  "era",
  "origin",
  "quote",
  "lore",
];

type SlotDef = {
  name: string;
  /** PRNG slot index (roll position; a uint8). Append-only. */
  index: number;
  values: readonly string[];
  /** Integer weights (×10, sum 1000 per slot — spec_v2 draft table). */
  weights: readonly number[];
};

/**
 * All 15 slots in roll order (indices 0–14; append-only — new categories get
 * NEW indices, existing ones never shift; spec v2.1, handoff 2026-09-19).
 */
export const ARC_TRAITS_SLOTS: readonly SlotDef[] = [
  {
    name: "background",
    index: 0,
    values: [
      "City",
      "Night",
      "Forest",
      "Beach",
      "Office",
      "Construction",
      "Snow",
      "Lab",
      "Space",
      "Sunset",
    ],
    weights: [140, 130, 120, 110, 100, 90, 90, 80, 80, 60],
  },
  {
    name: "head",
    index: 1,
    values: ["Default", "Scar", "Female", "Ice", "Pale", "Reptile"],
    weights: [700, 80, 110, 60, 40, 10],
  },
  {
    name: "outfit",
    index: 2,
    values: [
      "Tee",
      "Hoodie",
      "Jacket",
      "Builder",
      "Engineer",
      "Vest",
      "Hacker",
      "Analyst",
      "Techwear",
      "Coat",
      "Lab Coat",
      "Architect",
    ],
    weights: [140, 130, 120, 100, 100, 90, 85, 75, 70, 50, 30, 10],
  },
  {
    name: "hair",
    index: 3,
    values: ["Short", "Curly", "Long"],
    weights: [450, 350, 200],
  },
  {
    name: "eyes",
    index: 4,
    values: ["Default", "Explorer", "Red", "Laser", "Soft"],
    weights: [580, 200, 90, 10, 120],
  },
  {
    name: "nose",
    index: 5,
    values: ["Default", "Straight", "Button", "Rounded", "Angular"],
    weights: [650, 160, 90, 90, 10],
  },
  {
    name: "mouth",
    index: 6,
    values: [
      "Default",
      "Smile",
      "Smirk",
      "Fangs",
      "Frown",
      "Grin",
      "Open",
      "Soft",
      "Surprised",
    ],
    weights: [420, 185, 100, 60, 70, 90, 37, 30, 8],
  },
  {
    name: "eyewear",
    index: 7,
    values: ["None", "Glasses", "Sunglasses", "USDC Lenses", "Mono"],
    weights: [370, 250, 220, 150, 10],
  },
  {
    name: "headwear",
    index: 8,
    values: [
      "None",
      "Cap",
      "Beanie",
      "Hard Hat",
      "Headphones",
      "Halo",
      "Crown",
      "Gold Kippah",
    ],
    weights: [335, 180, 165, 145, 120, 40, 10, 5],
  },
  {
    name: "companion",
    index: 9,
    values: [
      "None",
      "Dog",
      "Cat",
      "Mouse",
      "Drone",
      "Robot",
      "AI Orb",
      "Flying Rat",
      "Bonkguy",
      "Winged Rat",
      "Gold Fly",
    ],
    weights: [325, 125, 105, 95, 85, 75, 60, 45, 70, 10, 5],
  },
  {
    name: "era",
    index: 10,
    values: [
      "Genesis",
      "Day One",
      "Season One",
      "House",
      "Expansion",
      "Private Mainnet",
    ],
    weights: [380, 200, 160, 120, 90, 50],
  },
  {
    name: "origin",
    index: 11,
    values: [
      "Community",
      "Discord Queue",
      "Early Wanderer",
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
    index: 12,
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
    weights: [455, 80, 70, 70, 60, 60, 50, 40, 40, 30, 20, 20, 5],
  },
  {
    name: "lore",
    index: 13,
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
    weights: [560, 100, 90, 80, 70, 50, 40, 10],
  },
  {
    // Render modifier (spec v2.1): no own layer — selects the hair asset via
    // `hair-colors/<color>/<style>.png` (fallback `hair/<style>.png`).
    name: "hair_color",
    index: 14,
    values: ["Brown", "Black", "Blond", "Ginger", "Ice", "Green", "White"],
    weights: [310, 235, 175, 115, 95, 60, 10],
  },
];

/**
 * Deterministically derives the full ARC-traits/2 set from a bytes32 seed.
 * Same PRNG contract as house-card/1 (`weightedPickFromSeed`, counter resets
 * per slot); no conditional rules in v2.
 */
export function deriveAttributesV2(seed: Hex): DerivedAttributes {
  const values = new Map<string, string>();

  for (const slot of ARC_TRAITS_SLOTS) {
    const index = weightedPickFromSeed(seed, slot.index, slot.weights);
    values.set(slot.name, slot.values[index]);
  }

  return {
    attributes: ARC_TRAITS_SLOTS.map((slot) => ({
      slot: slot.name,
      value: values.get(slot.name)!,
    })),
    golden: false,
  };
}
