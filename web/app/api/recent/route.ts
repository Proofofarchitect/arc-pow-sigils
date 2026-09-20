import { NextResponse } from "next/server";
import { getRecentActivity } from "@/lib/recent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live activity feed: the latest Claimed / Mined events of the core contract.
 * Cached ~20s server-side; safe for client polling.
 */
export async function GET() {
  const events = await getRecentActivity(10);
  return NextResponse.json(
    { events },
    {
      headers: {
        "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60",
      },
    },
  );
}
