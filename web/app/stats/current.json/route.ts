import { NextResponse } from "next/server";
import { getStatsSnapshot } from "@/lib/stats";

/**
 * /stats/current.json — live, citable collection snapshot.
 *
 * Node runtime (viem RPC reads) + force-dynamic so the CDN caches the
 * response for 60s (matching the in-process stats cache) and revalidates.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET() {
  try {
    const snapshot = await getStatsSnapshot();
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Unable to load stats snapshot", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
