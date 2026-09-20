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
