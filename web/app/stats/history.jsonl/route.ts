import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * /stats/history.jsonl — append-only snapshot log (JSON Lines).
 *
 * Served from the repo-seeded file at public/data/stats-history.jsonl. Kept
 * out of the static public path on purpose: this route owns the
 * application/x-ndjson content type and the cache policy.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";
const HISTORY_PATH = ["public", "data", "stats-history.jsonl"] as const;

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), ...HISTORY_PATH);
    const body = await readFile(filePath, "utf8");

    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": CACHE_CONTROL,
      },
    });
  } catch {
    // No snapshot log available in this deployment (e.g. the seeded file at
    // public/data/stats-history.jsonl is absent from the serverless bundle, or
    // no snapshots have been recorded yet). The endpoint is documented as an
    // append-only NDJSON stream, so answer with a valid — empty — JSONL body
    // and an explanatory header instead of a bare 404. (openapi sync is owned
    // separately.)
    return new Response("", {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Stats-History": "empty (no snapshots recorded)",
      },
    });
  }
}
