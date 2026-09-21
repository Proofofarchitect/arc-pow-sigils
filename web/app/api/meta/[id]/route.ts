import { NextResponse } from "next/server";
import { parseTokenId } from "@/lib/chain";
import { attributesForMetadata } from "@/lib/traits";
import { getTraitsForToken } from "@/lib/hc2chain";
import { SITE_URL } from "@/lib/site";
import { IS_V2 } from "@/lib/traits-set";
import { uniquePieceForId } from "@/lib/uniques";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

/**
 * OpenSea-compatible House Card metadata.
 *
 * Traits derive deterministically from the token's on-chain seed (see
 * `lib/traits.ts`, a port of `art/pipeline.py`). Absolute URLs use
 * `NEXT_PUBLIC_SITE_URL` (fallback https://proofofarchitect.builders).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const tokenId = parseTokenId(id);

  if (tokenId === null) {
    return NextResponse.json(
      { error: "Token ID must be an unsigned integer" },
      { status: 400 },
    );
  }

  try {
    // Normal ids derive from the seed (house-card/1); crafted ids (≥ 10M)
    // resolve via HC/2 (Crafted log + parent seeds). Crafted fallbacks surface
    // as `crafted: true` + `craftedLookup: "unavailable"`.
    const traits = await getTraitsForToken(tokenId);

    // Sealed 1-of-1 (arc-uniques/1): minimal metadata — the whole-scene piece
    // replaces the composite render, so the 15 seed traits are not shown.
    const piece = uniquePieceForId(tokenId);
    if (piece) {
      return NextResponse.json(
        {
          name: `Architector #${tokenId} — ${piece.name}`,
          description:
            `One of 18 legendary one-of-one Architectors hidden in the collection. ` +
            `${piece.name} (${piece.category}) — whole-scene artwork, revealed at mint. ` +
            `Served by ${SITE_URL}.`,
          image: `${SITE_URL}/api/image/${tokenId}`,
          external_url: `${SITE_URL}/token/${tokenId}`,
          attributes: [
            { trait_type: "Set", value: "Unique" },
            { trait_type: "Piece", value: piece.name },
            { trait_type: "Class", value: piece.category },
          ],
          unique: true,
        },
        { headers: { "Cache-Control": CACHE_CONTROL } },
      );
    }

    const body: Record<string, unknown> = {
      name: `Proof of Architect #${tokenId}`,
      description: IS_V2
        ? `Architector #${tokenId} — a deterministic NFT whose art and traits are ` +
          `generated on demand from the token's immutable on-chain seed. ` +
          `Each card composites 15 seed-derived ARC trait slots. Served by ${SITE_URL}.`
        : `House Card #${tokenId} — a deterministic NFT whose art and traits are ` +
          `generated on demand from the token's immutable on-chain seed. ` +
          `Each card composites 15 seed-derived House Card slots. Served by ${SITE_URL}.`,
      image: `${SITE_URL}/api/image/${tokenId}`,
      external_url: `${SITE_URL}/token/${tokenId}`,
      // `attributes` stays byte-identical to preserve marketplace rarity
      // ranking; the canonical rarity/1 score is exposed as a sibling field.
      attributes: attributesForMetadata(traits.derived),
      rarity: {
        score: Number(traits.rarity.score.toFixed(4)),
        tier: traits.rarity.tier,
      },
    };

    // Crafted ids additionally advertise their provenance + lookup status.
    if (traits.crafted) {
      body.crafted = true;
      body.craftedLookup = traits.craftedLookup;
    }

    return NextResponse.json(body, {
      headers: {
        "Cache-Control": CACHE_CONTROL,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // ownerOf commonly reverts when a token has not been minted.
    if (/revert|owner|exist|minted|not found/i.test(message)) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Unable to load token metadata" },
      { status: 500 },
    );
  }
}
