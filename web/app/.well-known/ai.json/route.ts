import { SITE_URL } from "@/lib/site";
import { CONTRACT_ADDRESS, ARC_CHAIN_ID } from "@/lib/contract";

/**
 * /.well-known/ai.json — service discovery for AI agents (RFC 8615 style).
 * Describes the collection, endpoints and MCP tools so crawlers/agents can
 * self-configure without scraping HTML.
 *
 * Live since 2026-09-21 — the `launch` block reports mode: "live" and all
 * chain surfaces are open.
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  return Response.json(
    {
      name: "Proof of Architect",
      description:
        "Proof-of-work minted NFT collection on Arc (Circle L1, USDC gas). Mine a keccak nonce; a valid nonce is stored on-chain as seedOf, and the display/art seed is derived POST-INCLUSION from seedOf and a later block hash (the mint block + 2) — traits are not knowable before mint.",
      version: "3.4",
      site: SITE_URL,
      llms: {
        index: `${SITE_URL}/llms.txt`,
        full: `${SITE_URL}/llms-full.txt`,
      },
      links: {
        x: "https://x.com/proof_of_arc",
        gitbook: "https://proofofarchitect.gitbook.io/proof-of-architect/",
      },
      launch: {
        mode: "live",
        note:
          "Live on Arc mainnet (chainId 5042, USDC gas) since 2026-09-21. All action pages and chain APIs are open (metadata, MCP, points, agents, stats). The contract below is the canonical mainnet deployment.",
      },
      endpoints: {
        robots: `${SITE_URL}/robots.txt`,
        sitemap: `${SITE_URL}/sitemap.xml`,
        openapi: `${SITE_URL}/openapi.yaml`,
        metadata: `${SITE_URL}/api/meta/{id}`,
        image: `${SITE_URL}/api/image/{id}`,
        mcp: `${SITE_URL}/api/mcp`,
        claim: `${SITE_URL}/claim`,
        points: `${SITE_URL}/points`,
        agents: `${SITE_URL}/agents`,
        points_api: `${SITE_URL}/api/points`,
        agents_api: `${SITE_URL}/api/agents`,
      },
      stats: {
        current: `${SITE_URL}/stats/current.json`,
        history: `${SITE_URL}/stats/history.jsonl`,
      },
      points: {
        domain: "proofofarchitect.points/1",
        season: 1,
        rules: { mine: 100, claim: 50, forge: 150, burn: 30 },
        dataset: `${SITE_URL}/api/points`,
        note: "Season 1 points are planned to convert into future PARC rewards (subject to change, no guarantees).",
      },
      agents: {
        page: `${SITE_URL}/agents`,
        registry: `${SITE_URL}/api/agents`,
        note: "Agents are ordinary wallets; register self-serve with a wallet signature (POST /api/agents/register). Ranking is on-chain activity only — no boosts for sale.",
      },
      agent_docs: {
        access: `${SITE_URL}/docs/agent-access`,
        verification: `${SITE_URL}/docs/verification`,
      },
      changelog: `${SITE_URL}/changelog.xml`,
      mcp: {
        transport: "streamable-http",
        tools: [
          "collection_stats",
          "get_token",
          "required_bits",
          "verify_nonce",
          "price_info",
          "craft_info",
        ],
      },
      collection: {
        standard: "ERC-721 (ERC-2981 royalties 5%)",
        symbol: "PARC",
        chain_id: ARC_CHAIN_ID,
        chain_name: "Arc",
        gas_token: "USDC (18 decimals native)",
        contract: CONTRACT_ADDRESS,
        network_note: "Arc mainnet (Circle L1), USDC gas, chainId 5042.",
        explorer: `https://explorer.arc.io/address/${CONTRACT_ADDRESS}`,
        max_supply: 15042,
        free_claims: 42,
        paid_supply: 15000,
        epoch_size: 1000,
        waves: 15,
        base_price_usdc: "1.0",
        price_growth: "x2 per wave",
        max_price_usdc: null,
        base_bits: 30,
      },
      mechanics: {
        work: "keccak256(abi.encodePacked(uint256 chainId, address contract, address miner, uint256 nonce))",
        validity: "uint256(work) < targetFor(miner) — milli-bit fractional difficulty; requiredBits(miner) is the display value",
        difficulty_layers: [
          "wave base: baseBits 30 + 2 bits per wave",
          "load regulator: pace target 25 s/mint over a 5-mint window, +2 bits / -1 bit (cap 64 bits)",
          "per-wallet streak: +2 bits per extra mint; flat cooldowns 5/10/15/20/25 minutes",
        ],
        seed:
          "seedOf(tokenId) is stored on-chain at mint (the raw work hash, or the claim hash for a free claim); the display/art seed is keccak256 of seedOf concatenated with blockhash(mintBlockOf(id) + 2) — post-inclusion, so traits are not knowable before mint",
        art:
          "Architector (ARC-traits/2): 15 slots — 10 rendered pixel layers, a hair-color render modifier, and 4 metadata-only slots — derived deterministically from the seed",
        free_lock: "free-claim tokens are non-transferable until wave >= 5",
      },
      updated_at: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}
