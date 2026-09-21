import { SITE_URL } from "@/lib/site";
import { CANON_CORE } from "@/lib/canonical";
import { ARC_CHAIN_ID } from "@/lib/contract";

/**
 * /index.md — markdown version of the collection page (llms.txt v2 convention).
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const body = `# Proof of Architect — collection overview

> Proof-of-work minted NFT collection on Arc (Circle L1, chainId ${ARC_CHAIN_ID}). Mine a keccak-256 nonce in the browser or on GPU; a valid nonce is stored on-chain as the token's seedOf, and the display/art seed is derived POST-INCLUSION from seedOf and the block hash of the mint block + 2 — the Architector traits are not knowable before mint.
>
> Launch status: LIVE on Arc mainnet since 2026-09-21 (chainId 5042, USDC gas). All pages and APIs are open.

## What you get

Each token is an "Architector": 15 slots — 10 rendered pixel-art layers (background, head, outfit, hair, eyes, nose, mouth, eyewear, headwear, companion), a hair-color render modifier, and 4 metadata-only slots (era, origin, quote, lore) — all a pure function of the mined hash (ARC-traits/2 set). No randomness, no oracle — anyone can recompute a card from its on-chain seed.

## Key numbers

- Contract: ${CANON_CORE} (Arc mainnet, ERC-721, symbol PARC, v3.4; 2.5% mint fee)
- Supply: 15,042 = 42 free claim codes + 15,000 paid, tokenId 1..15,042
- Paid price: 1.0 USDC at wave 1, doubling every wave of 1,000 mints with no cap (last wave 16,384 USDC)
- Free claims: 42 code-gated mints (non-transferable until wave 5)
- Claim (free code): call claim(bytes32 code) with msg.value 0 — no PoW, no payment, one Architector per single-use code
- Difficulty: three layers — wave base (baseBits 30 + 2 per wave), a load regulator, and a per-wallet streak
- Royalties: 5% (ERC-2981) to the immutable treasury

## Links

- [Mining guide](${SITE_URL}/mine.md)
- [Crafting (HC/2)](${SITE_URL}/craft)
- [Staking](${SITE_URL}/stake)
- [Claim free code](${SITE_URL}/claim)
- [Full documentation](${SITE_URL}/llms-full.txt)
- [Live collection](${SITE_URL}/)
- [Mine page](${SITE_URL}/mine)
- [Metadata API example](${SITE_URL}/api/meta/1)
- [Service discovery](${SITE_URL}/.well-known/ai.json)
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
