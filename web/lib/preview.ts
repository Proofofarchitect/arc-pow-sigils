import { encodePacked, keccak256 } from "viem";
import {
  attributeMap,
  deriveAttributes,
  HOUSE_CARD_SLOTS,
  type DerivedAttributes,
} from "./traits";
import { deriveAttributesV2 } from "./traits_v2";
import { IS_V2 } from "./traits-set";
import { informationContent, tierForScore, type RarityTier } from "./rarity";
import { informationContentV2, tierForScoreV2 } from "./rarity_v2";

/**
 * Preview mode — testnet deployments (and pre-launch builds) render a window of
 * deterministic preview cards so the collection looks complete before real
 * mints exist. Controlled by `NEXT_PUBLIC_PREVIEW_CAP` (0 = off, the
 * production default).
 *
 * A preview card for id N is derived from `keccak256("poa-preview" ‖ uint256(N))`
 * — fully deterministic, computed identically on the server (image/meta routes)
 * and in the browser (collection + token pages). As soon as a token is actually
 * minted, its on-chain seed takes over and the preview vanishes for that id.
 *
 * The value is inlined into the client bundle at build time (NEXT_PUBLIC_*).
 */
export const PREVIEW_CAP: number = Number.parseInt(
  process.env.NEXT_PUBLIC_PREVIEW_CAP ?? "0",
  10,
) || 0;

/**
 * Values struck from preview cards (owner decision, 17.09): ONLY the noise
 * animations — animals (companions), artifacts (tools) and bugs — are off;
 * golden events (cat/rat) are disabled for the same reason. Everything else
 * stays on: outfit, face, headwear, eyes, backgrounds, era/origin/quote/lore.
 * THIS IS PREVIEW-ONLY — `art/spec.json` and the canonical derivation are
 * untouched, so real mints are unaffected.
 */
function allValuesExceptNone(slotName: string): readonly string[] {
  return (
    HOUSE_CARD_SLOTS.find((slot) => slot.name === slotName)?.values.filter(
      (value) => value !== "None",
    ) ?? []
  );
}

export const PREVIEW_EXCLUDED: Record<string, readonly string[]> = {
  bug: allValuesExceptNone("bug"),
  companion: allValuesExceptNone("companion"),
  tool: allValuesExceptNone("tool"),
};

/**
 * The four collection personalities (spec body values), cycled across the
 * preview window so every card in the grid shows a different character and all
 * four are guaranteed to be represented (guy / girl / alien / reptile).
 */
export const PREVIEW_BODY_CYCLE: readonly string[] = [
  "Builder Frame",
  "Clerk Frame",
  "Architect Frame",
  "Shadow Frame",
];

/** Deterministic preview seed for a token id. */
export function previewSeed(id: bigint): `0x${string}` {
  return keccak256(encodePacked(["string", "uint256"], ["poa-preview", id]));
}

/** True when the id is inside the preview window. */
export function isPreviewId(id: bigint): boolean {
  return PREVIEW_CAP > 0 && id > 0n && id <= BigInt(PREVIEW_CAP);
}

/** Convenience overload for number ids. */
export function previewSeedFor(id: number | bigint): `0x${string}` {
  return previewSeed(typeof id === "bigint" ? id : BigInt(id));
}

/**
 * Preview-only derivation: canonical PRNG on the preview seed with the
 * exclusions above (golden disabled), and the body cycled across
 * PREVIEW_BODY_CYCLE so all four personalities are visible in the grid.
 */
export function derivePreviewAttributes(
  id: number | bigint,
): DerivedAttributes {
  // ARC-traits/2: plain v2 derivation of the preview seed (no exclusions, no
  // body cycle — the artist set has a single character).
  if (IS_V2) {
    return deriveAttributesV2(previewSeedFor(id));
  }

  const derived = deriveAttributes(previewSeedFor(id), {
    excludeValues: PREVIEW_EXCLUDED,
    disableGolden: true,
  });

  const numericId = typeof id === "bigint" ? Number(id) : id;
  const body =
    PREVIEW_BODY_CYCLE[
      ((numericId - 1) % PREVIEW_BODY_CYCLE.length + PREVIEW_BODY_CYCLE.length) %
        PREVIEW_BODY_CYCLE.length
    ];

  return {
    ...derived,
    attributes: derived.attributes.map((attribute) =>
      attribute.slot === "body" ? { ...attribute, value: body } : attribute,
    ),
  };
}

/** Locally computed rarity for a preview card (same derivation as its image). */
export function previewCardMeta(id: number | bigint): {
  score: number;
  tier: RarityTier;
} {
  const attrs = attributeMap(derivePreviewAttributes(id));
  if (IS_V2) {
    const score = informationContentV2(attrs);
    return { score, tier: tierForScoreV2(score) };
  }
  const score = informationContent(attrs);
  return { score, tier: tierForScore(score) };
}
