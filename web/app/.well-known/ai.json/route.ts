import { SITE_URL } from "@/lib/site";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS } from "@/lib/contract";

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
        note: "Season 1 points are an activity ledger for this network season; no conversion and no rewards are promised.",
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
        validity: "uint256(work) < targetFor(miner) (fractional difficulty; requiredBits/min requiredMilli are the display values)",
        difficulty_layers: [
          "wave base: baseBits 30 + 2 bits per wave",
          "load regulator: pace target 25 s/mint over a 5-mint window (+2 bits when fast, -1 bit when slow), +/-20% dead zone, 0..64 bits",
          "per-wallet streak: +2 bits per extra mint inside a flat 5-25 min streak-level cooldown (capped at 25); resets after the cooldown",
          "staking discount: stakingDiscountMilli(wallet) in milli-bits (up to 6000 = 6 bits) subtracted from the difficulty, floored at baseBits",
        ],
        seed:
          "raw seedOf(tokenId) = winning work hash (or claim hash / craft pre-seed). The ART display seed = keccak256(seedOf ‖ blockhash(mintBlockOf + 2)); claim tokens (mintBlockOf 0) keep seedOf. Post-inclusion: traits cannot be previewed or ground for before minting.",
        art:
          "Architector: 10 rendered pixel layers + a golden overlay + 4 metadata-only slots, derived deterministically from the display seed",
        free_lock: "free-claim tokens are non-transferable until wave >= 5",
        crafting:
          "one-shot CraftingControllerV2: craft(cardA, cardB, choices, boostTier) payable burns both parents and forges the child atomically (no commit/reveal/refund)",
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
