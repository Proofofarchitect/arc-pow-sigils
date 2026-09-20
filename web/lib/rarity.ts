/**
 * rarity.ts — canonical rarity/1 score (OpenRarity-style information content, bits).
 *
 * FROZEN SPEC. This file is the single source of truth for the House Card
 * rarity score across the web UI, API, and MCP tooling. The rules mirror
 * rarity notes §1 exactly and are parity-gated against the Python reference
 * (art/test_vectors_rarity.json) via `npm run check:rarity`.
 *
 * Changing any slot/value/weight in art/spec.json — or the golden/bug rules —
 * invalidates this domain and requires a new domain `rarity/2`. Existing card
 * scores must never be rewritten. (Pre-launch exception: session 27 cut the
 * headwear set and removed the golden Bat Hat event; nothing had been published
 * yet, so the domain id stayed `rarity/1` and the calibration was redone.
 * Any change after launch requires `rarity/2`.)
 *
 * score = IC_main (the 13 weighted slots, excluding the conditional bug slot)
 *       + IC_golden + IC_bug.
 *
 * All arithmetic uses IEEE754 doubles and Math.log2 with no rounding; the input
 * is `attributeMap(deriveAttributes(seed))` — all 15 slots, including the
 * "golden" and "bug" pseudo-slots.
 */
import type { Hex } from "viem";
import {
  GOLDEN_THRESHOLD,
  HOUSE_CARD_SLOTS,
  NONE,
  attributeMap,
  deriveAttributes,
} from "./traits";

export type RarityTier = "Standard" | "Notable" | "Rare" | "Epic" | "Mythic";

/**
 * Tier boundaries in bits: P50, P90, P99, P99.9 from `art/rarity_stats.py`
 * (Monte-Carlo N=600 000, seed=20260916; recalibrated sessions 27 + 30 for the
 * current spec — Kippah / Golden Fly). rarity notes §2.
 */
export const RARITY_THRESHOLDS: readonly [number, number, number, number] = [
  32.54, 37.92, 42.51, 45.94,
];

/** Stake-weight / points multipliers per tier (rarity notes §2 table, cap 3.0×). */
export const RARITY_MULTIPLIERS: Record<RarityTier, number> = {
  Standard: 1.0,
  Notable: 1.2,
  Rare: 1.6,
  Epic: 2.2,
  Mythic: 3.0,
};

/**
 * Percentile anchors (IC bits → collection percentile rank), from
 * `art/rarity_stats.py` (Monte-Carlo N=600 000, seed=20260916; same run as the
 * tier thresholds, recalibrated sessions 27 + 30). Ascending in bits. Mirrors the
 * rarity notes §2 anchor line:
 * P1 24.18 · P10 27.60 · P25 29.87 · P50 32.54 · P75 35.34 · P90 37.92 ·
 * P95 39.49 · P99 42.51 · P99.9 45.94.
 */
const PERCENTILE_ANCHORS: readonly (readonly [number, number])[] = [
  [24.18, 1],
  [27.6, 10],
  [29.87, 25],
  [32.54, 50],
  [35.34, 75],
  [37.92, 90],
  [39.49, 95],
  [42.51, 99],
  [45.94, 99.9],
];

/**
 * Map an IC score (bits) to its approximate collection percentile rank
 * (100 ⇒ rarest; e.g. P50 ⇒ 50), by piecewise-linear interpolation over
 * PERCENTILE_ANCHORS. Scores outside the anchor range clamp to the nearest
 * anchor's percentile; the result is always clamped to [0.01, 99.99].
 *
 * "Top X%" = 100 − this value (a card at percentile 87.7 is top 12.3%).
 */
export function rarityPercentile(score: number): number {
  const anchors = PERCENTILE_ANCHORS;
  const last = anchors.length - 1;
  let pct: number;

  if (score <= anchors[0][0]) {
    pct = anchors[0][1];
  } else if (score >= anchors[last][0]) {
    pct = anchors[last][1];
  } else {
    pct = anchors[last][1];
    for (let i = 1; i < anchors.length; i++) {
      const x0 = anchors[i - 1][0];
      const x1 = anchors[i][0];
      if (score <= x1) {
        const t = (score - x0) / (x1 - x0);
        pct = anchors[i - 1][1] + t * (anchors[i][1] - anchors[i - 1][1]);
        break;
      }
    }
  }

  return Math.min(99.99, Math.max(0.01, pct));
}

/** c = GOLDEN_THRESHOLD / 65536 = 1966 / 65536 ≈ 0.03 (3% of the uint16 space). */
const GOLDEN_CHANCE = GOLDEN_THRESHOLD / 65_536;

function findSlot(name: string) {
  const slot = HOUSE_CARD_SLOTS.find((candidate) => candidate.name === name);
  if (!slot) throw new Error(`rarity: unknown slot "${name}"`);
  return slot;
}

/** Integer weight (×10, so p = weight/1000) of a specific value within a slot. */
function weightOf(slotName: string, value: string): number {
  const slot = findSlot(slotName);
  const index = slot.values.indexOf(value);
  if (index < 0 || slot.weights === null) {
    throw new Error(`rarity: unexpected value "${value}" for slot "${slotName}"`);
  }
  return slot.weights[index];
}

/** One slot's additive IC contribution, in bits. */
export type SlotContribution = { slot: string; bits: number };

type ICTerms = {
  /** The 13 weighted slots' contributions, in HOUSE_CARD_SLOTS order. */
  main: SlotContribution[];
  /** IC_golden — conditional golden pseudo-slot term. */
  golden: number;
  /** IC_bug — conditional bug pseudo-slot term. */
  bug: number;
};

/**
 * Internal term decomposition shared by `informationContent` and
 * `slotContributions`. Computed once so the two public functions never
 * duplicate the term math — their sums agree by construction.
 *
 * `values` must contain all 15 slots (e.g. `attributeMap(deriveAttributes(seed))`).
 */
function computeTerms(values: Record<string, string>): ICTerms {
  const c = GOLDEN_CHANCE;

  // Eligibility probabilities derived from the prerequisite values' weights
  // (never hardcoded): e2 = P(companion == "House Cat"), e3 = P(companion ==
  // "Fat Rat"). The Bat Hat headwear event was removed in session 27.
  const e2 = weightOf("companion", "House Cat") / 1000;
  const e3 = weightOf("companion", "Fat Rat") / 1000;

  // P(no golden event) — the same product feeds both IC_golden and IC_bug.
  // This is the unconditional-marginal approximation frozen in rarity notes §1:
  // we do NOT condition on the token's actual prerequisite values.
  const pNoGolden = (1 - e2 * c) * (1 - e3 * c);

  // 1. IC_main — the 13 weighted slots, in HOUSE_CARD_SLOTS order. golden
  //    (weights === null) and bug (conditional) are excluded here.
  const main: SlotContribution[] = [];
  for (const slot of HOUSE_CARD_SLOTS) {
    if (slot.name === "bug" || slot.weights === null) continue;
    const weight = weightOf(slot.name, values[slot.name]);
    main.push({ slot: slot.name, bits: -Math.log2(weight / 1000) });
  }

  // 2. IC_golden — conditional pseudo-slot, first-success-wins semantics.
  const golden = values.golden;
  let pGolden: number;
  switch (golden) {
    case NONE:
      pGolden = pNoGolden;
      break;
    case "House Cat":
      pGolden = e2 * c;
      break;
    case "Fat Rat":
      pGolden = e3 * c * (1 - e2 * c);
      break;
    default:
      throw new Error(`rarity: unexpected golden value "${golden}"`);
  }
  const icGolden = -Math.log2(pGolden);

  // 3. IC_bug — rolled only when legendary == None AND no golden fired.
  const w0 = weightOf("legendary", NONE) / 1000; // P(legendary == None) = 910/1000
  const pGate = w0 * pNoGolden;

  // Σ non-None bug weights / 1000 = 550/1000 = 0.55.
  const bugSlot = findSlot("bug");
  const bugWeights = bugSlot.weights!;
  let nonNoneBugFraction = 0;
  for (let i = 0; i < bugSlot.values.length; i++) {
    if (bugSlot.values[i] !== NONE) nonNoneBugFraction += bugWeights[i] / 1000;
  }

  const bug = values.bug;
  const pBug =
    bug !== NONE
      ? pGate * (weightOf("bug", bug) / 1000)
      : 1 - pGate * nonNoneBugFraction;
  const icBug = -Math.log2(pBug);

  return { main, golden: icGolden, bug: icBug };
}

/**
 * Information content of a fully-derived House Card, in bits.
 *
 * `values` must contain all 15 slots (e.g. `attributeMap(deriveAttributes(seed))`).
 * The score is the sum of three independent terms:
 *   1. IC_main   — the 13 weighted slots (background … legendary), excluding bug.
 *   2. IC_golden — conditional golden pseudo-slot (unconditional-marginal model).
 *   3. IC_bug    — conditional bug pseudo-slot, gated on `legendary == None`.
 */
export function informationContent(values: Record<string, string>): number {
  const terms = computeTerms(values);

  // Summation order preserved from the pre-refactor implementation so the score
  // stays bit-identical (the parity gate compares ic within ±1e-6).
  let icMain = 0;
  for (const term of terms.main) icMain += term.bits;
  return icMain + terms.golden + terms.bug;
}

/**
 * Per-slot breakdown of the rarity/1 IC score, in canonical slot order
 * (HOUSE_CARD_SLOTS): the 13 weighted slots (each −log2(weight/1000)), then the
 * conditional "golden" and "bug" pseudo-slot terms. `sum(bits)` equals
 * `informationContent(values)` up to IEEE754 summation order (< 1e-12).
 */
export function slotContributions(
  values: Record<string, string>,
): SlotContribution[] {
  const terms = computeTerms(values);
  return [
    ...terms.main,
    { slot: "golden", bits: terms.golden },
    { slot: "bug", bits: terms.bug },
  ];
}

/** Map an IC score (bits) to its rarity tier (< is Standard-side, ≥ is upper). */
export function tierForScore(score: number): RarityTier {
  if (score < RARITY_THRESHOLDS[0]) return "Standard";
  if (score < RARITY_THRESHOLDS[1]) return "Notable";
  if (score < RARITY_THRESHOLDS[2]) return "Rare";
  if (score < RARITY_THRESHOLDS[3]) return "Epic";
  return "Mythic";
}

/** Full rarity result for a bytes32 seed: { score, tier }. */
export function rarityForSeed(seed: Hex): { score: number; tier: RarityTier } {
  const derived = deriveAttributes(seed);
  const score = informationContent(attributeMap(derived));
  return { score, tier: tierForScore(score) };
}
