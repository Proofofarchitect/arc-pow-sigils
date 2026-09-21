/**
 * traits-set.ts — which trait system this build renders.
 *
 * `NEXT_PUBLIC_TRAITS_SET=v2` switches the whole web surface (derivation,
 * rarity, renderer, metadata) to the artist ARC-traits/2 set; anything else is
 * the original house-card/1. The variable is NEXT_PUBLIC so the client (token
 * page) and the server (API routes) agree — flip with a Vercel env change +
 * redeploy; rollback is the same flip back (v1 assets stay in `public/traits`).
 */
export const TRAITS_SET: "v1" | "v2" =
  process.env.NEXT_PUBLIC_TRAITS_SET === "v2" ? "v2" : "v1";

export const IS_V2 = TRAITS_SET === "v2";

/**
 * Cache-busting query for rendered card images: every URL changes when the
 * trait set flips, so browsers/CDNs never serve a stale-art card (the
 * renderer itself is versioned by the deployment, this only forces clients
 * to refetch).
 */
export const TRAITS_IMAGE_QS = IS_V2 ? "?v=2" : "";


/**
 * Image-route query string. `w` requests a smaller render from the image API
 * (server-side downscale + CDN cache) — use for grids/thumbnails so cards are
 * not shipped at full size. `v=2` keeps the traits-set cache-buster.
 */
const IMAGE_W_SIZES = [64, 96, 128, 192, 256, 384, 512] as const;

/** Snap a desired thumbnail width to the middleware allowlist (bounded keys). */
export function snapImageWidth(w: number): number {
  return IMAGE_W_SIZES.find((x) => x >= w) ?? IMAGE_W_SIZES[IMAGE_W_SIZES.length - 1];
}

export function imageQuery(w?: number): string {
  const parts: string[] = [];
  if (IS_V2) parts.push("v=2");
  if (w && w > 0) parts.push(`w=${snapImageWidth(w)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
