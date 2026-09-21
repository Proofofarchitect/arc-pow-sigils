import registry from "./uniques-registry.json";

/**
 * uniques.ts — hidden 1-of-1 pieces (arc-uniques/1, owner decision 2026-09-20).
 *
 * 18 whole-scene pieces (P01–P18), exactly ONE copy each, bound to hidden
 * token ids. The sealed id list arrives via `UNIQUES_IDS` (server env only —
 * NEVER NEXT_PUBLIC): comma-separated token ids, position = piece index.
 * Fairness: commit-reveal — `ops/uniques/COMMITMENT.txt` holds
 * sha256(canonical_json({domain, ids, salt})); ids+salt are revealed after
 * all 18 are found (or sellout). See `art/v2/uniques/README.md`.
 *
 * IMPORTANT: import this module from server code only (API routes / server
 * libs). If a client component imports it, the sealed id list would leak into
 * the public bundle and the "unpredictable draw" breaks.
 *
 * Masking: callers resolve a piece ONLY after the token is known to exist
 * on-chain (minted). Unminted ids keep rendering the regular seed-derived card,
 * so the sealed list cannot be probed through /api/image.
 */
export type UniqueCategory = "People" | "Mythic";

export type UniquePiece = {
  code: string;
  slug: string;
  name: string;
  category: UniqueCategory;
  file: string;
  sha256: string;
  canvas: [number, number];
};

export const UNIQUES_DOMAIN = "arc-uniques/1";
export const UNIQUE_PIECES: readonly UniquePiece[] = registry.pieces as UniquePiece[];

let cache: Map<number, number> | null = null;

/** tokenId → piece index (parsed from the sealed `UNIQUES_IDS` list). */
function idMap(): Map<number, number> {
  if (cache) return cache;
  cache = new Map();
  const raw = (process.env.UNIQUES_IDS ?? "").trim();
  if (!raw) return cache;
  raw.split(",").forEach((chunk, idx) => {
    const id = Number(chunk.trim());
    if (Number.isInteger(id) && id > 0 && idx < UNIQUE_PIECES.length) {
      cache!.set(id, idx);
    }
  });
  return cache;
}

/**
 * The sealed 1-of-1 piece for a token id, or null when the id is not one of
 * the hidden uniques (or `UNIQUES_IDS` is not configured in this environment).
 * Accepts bigint (chain ids) and normalizes — unique ids live in 1..15042.
 */
export function uniquePieceForId(tokenId: number | bigint): UniquePiece | null {
  const id = typeof tokenId === "bigint" ? Number(tokenId) : tokenId;
  const idx = idMap().get(id);
  return idx === undefined ? null : UNIQUE_PIECES[idx];
}
