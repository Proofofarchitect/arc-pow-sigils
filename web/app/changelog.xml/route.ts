import { SITE_URL } from "@/lib/site";

/**
 * /changelog.xml — RSS 2.0 feed of shipped milestones.
 *
 * Change signal for feed readers and for agents that poll for freshness
 * (see discovery notes D6). Static: the milestone list is curated by
 * hand, not derived from git.
 *
 * Note: the whole project was built in a single documented day (16.09.2026);
 * the timestamps below are session-order approximations used only so feed
 * readers keep the right chronology.
 */
export const dynamic = "force-static";
export const revalidate = 3600;

const FEED_URL = `${SITE_URL}/changelog.xml`;

type Milestone = {
  title: string;
  link: string;
  guid: string;
  /** ISO 8601, UTC. */
  date: string;
  description: string;
};

// Newest first (feed order + lastBuildDate derive from index 0).
const MILESTONES: Milestone[] = [
  {
    title: "Contract v3.4 — post-inclusion entropy, milli-bit staking, one-shot craft",
    link: `${SITE_URL}/docs/verification`,
    guid: "poa:v3.4",
    date: "2026-09-21T12:00:00Z",
    description:
      "Canonical v3.4 core 0x8f579534…2491: post-inclusion entropy (the art seed is derived from a block hash that does not exist at submit time), milli-bit staking difficulty and one-shot craft (no commit/reveal/refund). Mint fee stays 2.5%. Contract suite 350/350; core, vault and craft verified on arcscan.",
  },
  {
    title: "Headwear set finalized + rarity recalibrated",
    link: `${SITE_URL}/llms-full.txt`,
    guid: "poa:headwear-final",
    date: "2026-09-17T20:00:00Z",
    description:
      "Headwear slot finalized: House Cap, Muted Hood, 500-Point Halo plus three new code-drawn hats (Office Headphones, Reverse Cap 404, Bandana, per-body, weights 120/110/60 of the slot). Golden Bat Hat event removed with the hat; rarity thresholds recalibrated (P50 32.25 / P90 37.62 / P99 42.18 bits). Parity gates green: traits 80, rarity 258, HC/2 1275 checks.",
  },
  {
    title: "GitBook documentation live",
    link: "https://proofofarchitect.gitbook.io/proof-of-architect",
    guid: "poa:gitbook",
    date: "2026-09-16T22:30:00Z",
    description:
      "14 sourced English pages deployed as a live 18-page GitBook tree with nested navigation and cross-links.",
  },
  {
    title: "Crafting controller v1 + rehearsal",
    link: `${SITE_URL}/craft`,
    guid: "poa:craft",
    date: "2026-09-16T21:00:00Z",
    description:
      "CraftingController.sol (commit-reveal) with the HC/2 renderer: 41 tests, suite 233/233, 1,275 HC/2 vectors; rehearsal 49/49 (controller 0xf3f3…5f79, child #10000003).",
  },
  {
    title: "Staking vault v1",
    link: `${SITE_URL}/stake`,
    guid: "poa:stake",
    date: "2026-09-16T19:30:00Z",
    description:
      "StakingVault.sol: stake tokens for a max-aggregated PoW difficulty discount (up to 4/6 bits), penalty only up to the stake lock. 27 tests (suite 192/192); rehearsal 24/25; vault 0x8860B49d…4231.",
  },
  {
    title: "Rarity showcase",
    link: `${SITE_URL}/docs/stats`,
    guid: "poa:rarity",
    date: "2026-09-16T18:00:00Z",
    description:
      "OpenRarity-compatible information content for every Architector (P50 33.95 / P90 39.16 / P99 43.55 bits; Standard…Mythic tiers). /api/meta now serves a rarity block and MCP gains verify_rarity; 258 parity checks (Python == TypeScript == chain).",
  },
  {
    title: "AI-discovery layer",
    link: `${SITE_URL}/llms.txt`,
    guid: "poa:ai-discovery",
    date: "2026-09-16T16:00:00Z",
    description:
      "robots.txt, llms.txt + llms-full.txt, .md page mirrors, JSON-LD, .well-known/ai.json, OpenAPI, IndexNow and a remote + stdio MCP server. Visibility probe 10/10.",
  },
  {
    title: "Contract v3.1 live",
    link: `${SITE_URL}/docs/verification`,
    guid: "poa:v3.1",
    date: "2026-09-16T14:00:00Z",
    description:
      "v3.1 adds burn, a forge quota (forged <= burned, id namespace 10M+) and a Safe-controlled module registry with up to 6 bits of PoW discount. 165/165 tests; REAL 0x6498…fc1 + SMALL 0xb88e…668 verified on arcscan; smoke 48/48.",
  },
  {
    title: "ProofMint v3 deployed and verified",
    link: `${SITE_URL}/llms-full.txt`,
    guid: "poa:v3",
    date: "2026-09-16T11:00:00Z",
    description:
      "v3 introduces three difficulty layers (wave base, load regulator, per-wallet streak), 42 free claim codes and an uncapped x2-per-wave price ladder (15,042 supply). 95/95 tests; REAL 0xCc223C0e1A943916f604d729Cddfb5B85f266193 verified on arcscan; smoke 103/103.",
  },
  {
    title: "Contracts v1 — proof-of-work minting",
    link: `${SITE_URL}/llms-full.txt`,
    guid: "poa:v1",
    date: "2026-09-16T08:00:00Z",
    description:
      "First working deployment: ERC721Minimal + PowMintNFT with keccak-256 proof-of-work minting (leading-zero-bits target, +2-bit escalation). 13/13 tests; token #1 minted on Arc from a CPU nonce.",
  },
];

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RFC 822 / RFC 1123 pubDate, as required by RSS 2.0. */
function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

export function GET() {
  const lastBuildDate = rfc822(MILESTONES[0].date);

  const items = MILESTONES.map(
    (m) => `    <item>
      <title>${esc(m.title)}</title>
      <link>${esc(m.link)}</link>
      <guid isPermaLink="false">${esc(m.guid)}</guid>
      <pubDate>${rfc822(m.date)}</pubDate>
      <description>${esc(m.description)}</description>
    </item>`
  ).join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Proof of Architect — changelog</title>
    <link>${esc(SITE_URL)}/</link>
    <description>Shipped milestones for Proof of Architect — a proof-of-work minted NFT collection on Arc (Circle L1).</description>
    <language>en</language>
    <atom:link href="${esc(FEED_URL)}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
