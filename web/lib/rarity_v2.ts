/**
 * rarity_v2.ts — ARC-traits/2 rarity score ("rarity/2" domain, provisional).
 *
 * Same information-content model as rarity/1 (OpenRarity-style bits), but over
 * the 15 v2 slots (10 rendered + hair_color modifier + 4 metadata) with the v2
 * weight table. v2 has no golden/bug conditional pseudo-slots, so the score is
 * a plain sum of -log2(weight / 1000) over all 15 slots.
 *
 * Thresholds/anchors: Monte-Carlo calibration N=100 000 seeds
 * (`v2lib.py --rarity`, spec v2.2 applied 2026-09-20; artifact
 * `art/v2/rarity_mc.json`): P50 35.06 · P90 40.61 · P99 45.43 · P99.9 49.33 —
 * still provisional (weights may get further owner tweaks).
 */
import type { Hex } from "viem";
import {
  RARITY_MULTIPLIERS,
  type RarityTier,
  type SlotContribution,
} from "./rarity";
import { ARC_TRAITS_SLOTS, deriveAttributesV2 } from "./traits_v2";
import { attributeMap } from "./traits";

/** Tier boundaries in bits: P50, P90, P99, P99.9 (MC N=100k, v2.2 weights). */
export const RARITY_V2_THRESHOLDS: readonly [number, number, number, number] = [
  35.06, 40.61, 45.43, 49.33,
];

/** Percentile anchors (IC bits → collection percentile rank), same MC run. */
const V2_PERCENTILE_ANCHORS: readonly (readonly [number, number])[] = [
  [26.57, 1],
  [30.06, 10],
  [32.35, 25],
  [35.06, 50],
  [37.92, 75],
  [40.61, 90],
  [42.23, 95],
  [45.43, 99],
  [49.33, 99.9],
];

/** Map an IC score (bits) to its approximate collection percentile rank. */
export function rarityPercentileV2(score: number): number {
  const anchors = V2_PERCENTILE_ANCHORS;
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

function weightOf(slotName: string, value: string): number {
  const slot = ARC_TRAITS_SLOTS.find((candidate) => candidate.name === slotName);
  if (!slot) throw new Error(`rarity/2: unknown slot "${slotName}"`);
  const index = slot.values.indexOf(value);
  if (index < 0) {
    throw new Error(`rarity/2: unexpected value "${value}" for slot "${slotName}"`);
  }
  return slot.weights[index];
}

/** Per-slot breakdown of the rarity/2 IC score (canonical slot order). */
export function slotContributionsV2(
  values: Record<string, string>,
): SlotContribution[] {
  return ARC_TRAITS_SLOTS.map((slot) => ({
    slot: slot.name,
    bits: -Math.log2(weightOf(slot.name, values[slot.name]) / 1000),
  }));
}

/** Information content of a fully-derived v2 card, in bits. */
export function informationContentV2(values: Record<string, string>): number {
  let score = 0;
  for (const contribution of slotContributionsV2(values)) {
    score += contribution.bits;
  }
  return score;
}

/** Map an IC score (bits) to its rarity tier (same tier names as rarity/1). */
export function tierForScoreV2(score: number): RarityTier {
  if (score < RARITY_V2_THRESHOLDS[0]) return "Standard";
  if (score < RARITY_V2_THRESHOLDS[1]) return "Notable";
  if (score < RARITY_V2_THRESHOLDS[2]) return "Rare";
  if (score < RARITY_V2_THRESHOLDS[3]) return "Epic";
  return "Mythic";
}

/** Full rarity result for a bytes32 seed under the v2 tables. */
export function rarityForSeedV2(seed: Hex): { score: number; tier: RarityTier } {
  const score = informationContentV2(attributeMap(deriveAttributesV2(seed)));
  return { score, tier: tierForScoreV2(score) };
}

export { RARITY_MULTIPLIERS };
