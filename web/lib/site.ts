/**
 * Canonical site facts shared by SEO / AI-discoverability routes
 * (robots, sitemap, llms.txt, .well-known, JSON-LD).
 *
 * NEXT_PUBLIC_SITE_URL must be set to the production domain before deploy.
 */
export const SITE_URL: string = (
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  "https://proofofarchitect.builders"
).replace(/\/+$/, "");

export const SITE_NAME = "Proof of Architect";

export const SITE_DESCRIPTION =
  "Proof-of-work minted NFT collection on Arc (Circle L1, USDC gas). Mine a keccak nonce in your browser — the winning hash becomes the token seed and all Architector traits derive from it. 15,042 supply; the first 42 are free claims.";
