import { NextResponse } from "next/server";
import { fetchAllPoints, fetchPointsFor, POINT_RULES } from "@/lib/points";

/**
 * /api/points — House Points (Season 1) dataset.
 *
 * Points are derived from public on-chain events (Mined/Claimed/Forged/Burned),
 * so every number is independently recomputable. Add ?address=0x… to get a
 * single wallet. Cached for 60s at the edge.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold scans walk the chain in 10k-block chunks under the RPC rate limit.
export const maxDuration = 60;

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const address = url.searchParams.get("address");

    if (address) {
      const wallet = await fetchPointsFor(address);
      return NextResponse.json(
        {
          domain: "proofofarchitect.points/1",
          season: 1,
          rules: POINT_RULES,
          address: address.toLowerCase(),
          wallet,
          updatedAt: new Date().toISOString(),
        },
        { headers: { "Cache-Control": CACHE_CONTROL } },
      );
    }

    const snapshot = await fetchAllPoints();
    return NextResponse.json(
      {
        domain: "proofofarchitect.points/1",
        season: 1,
        rules: POINT_RULES,
        updatedAt: new Date().toISOString(),
        computedAtBlock: snapshot.computedAtBlock,
        totals: snapshot.totals,
        wallets: snapshot.wallets.slice(0, 200),
      },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Unable to load points snapshot", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
