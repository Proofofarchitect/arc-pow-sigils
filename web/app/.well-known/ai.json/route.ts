import { SITE_URL } from "@/lib/site";
import { CONTRACT_ADDRESS } from "@/lib/contract";

/**
 * /.well-known/ai.json — service discovery for AI agents (RFC 8615 style).
 * Describes the collection, endpoints and MCP tools so crawlers/agents can
 * self-configure without scraping HTML.
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  return Response.json(
    {
      name: "Proof of Architect",
      description:
        "Proof-of-work minted NFT collection on Arc (Circle L1, USDC gas). Mine a keccak nonce; the winning hash becomes the token seed and the Architector art derives from it deterministically.",
      version: "3.0",
      site: SITE_URL,
      llms: {
        index: `${SITE_URL}/llms.txt`,
        full: `${SITE_URL}/llms-full.txt`,
      },
      links: {
        x: "https://x.com/proof_of_arc",
        gitbook: "https://proofofarchitect.gitbook.io/proof-of-architect/",
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
          "verify_rarity",
          "craft_info",
          "verify_craft_commit",
        ],
      },
      collection: {
        standard: "ERC-721 (ERC-2981 royalties 5%)",
        symbol: "PARC",
        chain_id: 5042002,
        chain_name: "Arc",
        gas_token: "USDC (18 decimals native)",
        contract: CONTRACT_ADDRESS,
        explorer: `https://testnet.arcscan.app/address/${CONTRACT_ADDRESS}`,
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
        validity: "leadingZeroBits(work) >= requiredBits(miner)",
        difficulty_layers: [
          "wave base: baseBits 30 + 2 bits per wave",
          "load regulator: pace target 30 s/mint over a 25-mint window, +/-20% dead zone, 0..64 bits",
          "per-wallet streak: +2 bits per extra mint inside a 60 s x wave cooldown; resets after the cooldown",
        ],
        seed:
          "winning work hash stored on-chain as seedOf(tokenId) (or the claim hash for a free claim)",
        art:
          "Architector: 10 rendered pixel layers + a golden overlay + 4 metadata-only slots, derived deterministically from the seed",
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
