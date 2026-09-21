import { NextResponse } from "next/server";
import sharp from "sharp";
import { parseTokenId } from "@/lib/chain";
import { getTraitsForToken } from "@/lib/hc2chain";
import { derivePreviewAttributes, isPreviewId } from "@/lib/preview";
import {
  imageHeaders,
  PREVIEW_CACHE_CONTROL,
  renderHouseCardPng,
} from "@/lib/renderer";
import { renderHouseCardPngV2 } from "@/lib/renderer_v2";
import { renderUniquePng } from "@/lib/renderer_uniques";
import { IS_V2 } from "@/lib/traits-set";
import { uniquePieceForId } from "@/lib/uniques";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ?w= thumbnail bounds (server-side downscale; the result is CDN-cached). */
const MIN_W = 32;
const MAX_W = 1254;

/**
 * Deterministic House Card PNG, rendered on demand from the token's on-chain
 * seed. `NEXT_PUBLIC_TRAITS_SET=v2` switches rendering to the artist ARC-traits
 * compositor (native 1254 canvas, ×3 master).
 *
 * Pass `?master=1` for the master size (3072 v1 / 3762 v2); default is display
 * (1024 v1 / 1254 v2). Pass `?w=<px>` for a small grid/thumbnail render
 * (32..1254, downscaled server-side) — use for grids so full-size PNGs are not
 * shipped. Non-minted ids 404 via the on-chain ownerOf read — except inside the
 * preview window (NEXT_PUBLIC_PREVIEW_CAP), where the card renders from a
 * deterministic preview seed (served with a short cache TTL).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const tokenId = parseTokenId(id);

  if (tokenId === null) {
    return new NextResponse("Invalid token ID", { status: 400 });
  }

  const search = new URL(request.url).searchParams;
  const master = search.get("master") === "1";
  const wRaw = Number.parseInt(search.get("w") ?? "", 10);
  const thumbW = Number.isFinite(wRaw)
    ? Math.min(MAX_W, Math.max(MIN_W, wRaw))
    : null;
  const render = IS_V2 ? renderHouseCardPngV2 : renderHouseCardPng;

  /** Downscale to the requested ?w= width when present. */
  const sized = async (png: Buffer) =>
    thumbW
      ? sharp(png).resize(thumbW, thumbW, { fit: "inside" }).png().toBuffer()
      : png;

  try {
    // Same resolution path as /api/meta: normal ids derive from the seed;
    // crafted ids (≥ 10M) compose from their HC/2 traits (fallback derivation
    // when HC/2 lookup is unavailable).
    const traits = await getTraitsForToken(tokenId);

    // Sealed 1-of-1 (arc-uniques/1): reachable only after the on-chain read
    // above succeeded (token exists) — so unminted unique ids keep rendering
    // the regular card and the sealed list stays unprobeable. When the id IS
    // one of the hidden uniques, serve the whole-scene piece.
    const piece = uniquePieceForId(tokenId);
    const png = piece
      ? await renderUniquePng(piece, { master })
      : await render(traits.derived, { master });

    return new NextResponse(new Uint8Array(await sized(png)), {
      status: 200,
      headers: imageHeaders(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // Preview window: not minted yet, but inside the testnet preview range —
    // render from the deterministic preview seed instead of 404ing. Also the
    // fallback for transient failures (e.g. RPC rate-limit on the seed read)
    // that would otherwise surface as a broken image. Content changes once the
    // token is minted → short cache TTL, not immutable.
    if (isPreviewId(tokenId)) {
      const png = await render(derivePreviewAttributes(tokenId), {
        master,
      });
      return new NextResponse(new Uint8Array(await sized(png)), {
        status: 200,
        headers: imageHeaders(PREVIEW_CACHE_CONTROL),
      });
    }

    // ownerOf commonly reverts when a token has not been minted.
    if (/revert|owner|exist|minted|not found/i.test(message)) {
      return new NextResponse("Token not found", { status: 404 });
    }

    return new NextResponse("Unable to render token image", { status: 500 });
  }
}
