import { SITE_URL } from "@/lib/site";
import { ARC_CHAIN_ID } from "@/lib/contract";
import { CRAFT_ADDRESS } from "@/lib/craft";
import { VAULT_ADDRESS } from "@/lib/staking";

/**
 * /llms.txt — llms.txt v2 (llmstxt.org) map for LLM agents.
 * Served from the site root; `.md` page versions are linked below.
 *
 * Craft/stake addresses are read from the same build env the app uses
 * (NEXT_PUBLIC_CRAFT_ADDRESS / NEXT_PUBLIC_VAULT_ADDRESS) so this map stays in
 * sync with the env swap; the placeholder below means "not deployed yet".
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const body = `# Proof of Architect

> Proof-of-work minted NFT collection on Arc (Circle L1, chainId ${ARC_CHAIN_ID}). Mine a keccak-256 nonce in the browser or on GPU — the mined hash is recorded on-chain as the token's seed (seedOf), and the Architector art seed derives post-inclusion from it plus a later block hash (keccak256(seedOf ‖ blockhash(mintBlockOf(id) + 2))), so traits are not knowable before the mint. 42 free claim codes and 15,000 paid mints across 15 waves; the paid price is 1.0 USDC at wave 1, doubling every wave with no cap, paid as native gas token USDC (a 2.5% mint fee is added on top; total due = currentMintDue()).

Key facts:
- Contract (ERC-721, symbol PARC): 0x8f5795343C10b316296f6767a10e87CC40E62491 (Arc, v3.4, verified on arcscan; a 2.5% mint fee is added on top of the wave price at mint)
- Mining formula: work = keccak256(abi.encodePacked(chainId, contract, miner, nonce)); valid when uint256(work) < targetFor(miner) (fractional difficulty in milli-bits; requiredBits is the display value)
- Post-inclusion entropy: the art seed is keccak256(seedOf ‖ blockhash(mintBlockOf + 2)), a block that does not exist at submit time, so traits cannot be previewed or ground for before minting (claim tokens keep a deterministic seed)
- Difficulty has three layers: a wave base (baseBits 30 + 2 per wave), a load regulator, and a per-wallet streak
- Art is an "Architector": 10 rendered pixel layers + a golden overlay + 4 metadata-only slots, all derived from the seed
- Difficulty, price and supply are readable on-chain; nonces can be verified without a transaction
- Free claims: 42 one-time codes — claim(bytes32 code) with 0 value, no proof of work and no payment (gas only); claimed tokens are non-transferable until wave 5
- Crafting (HC/2, one-shot): burn two cards you own into one forged child in a SINGLE payable craft(cardA, cardB, choices, boostTier) transaction — the parents are escrowed and burned and the child forged atomically, with no commit/reveal step and no refund. The child pre-seed packs both parents' raw seeds; the display seed adds blockhash(childMintBlock + 2), so the result is verifiable afterwards but never predictable before you commit. Controller: ${CRAFT_ADDRESS ?? "(not deployed — set NEXT_PUBLIC_CRAFT_ADDRESS)"}. Full flow in the "Crafting (HC/2)" section of llms-full.txt.
- Staking: lock an Architector for 0/7/30/90/180/365 days (tiers 0..5) for a PoW bits discount (2/2/4/4/6/6) and pool weight (0.1/0.5/1/2/3/4×). Staking is a HARD LOCK: a staked card stays in the vault until the end of the chosen term and cannot be withdrawn earlier (unstake reverts Locked(until) while now < stakedAt + lockDays(tier)·86400; no emergency exit, no cooldown). Tier 0 (0 days) is flexible and can be unstaked at any time. Vault: ${VAULT_ADDRESS ?? "(not deployed — set NEXT_PUBLIC_VAULT_ADDRESS)"}. Full flow in the "Staking" section of llms-full.txt.
- House Points (Season 1): points for mine (+100), free claim (+50), craft/forge (+150), burn (+30) — derived from on-chain events, planned to convert into future PARC rewards (subject to change; no guarantees)

## Docs

- [Collection overview](${SITE_URL}/index.md): mechanics, economics, Architector traits, determinism
- [Mining guide](${SITE_URL}/mine.md): how to mine a nonce and mint safely
- [Free claim codes](${SITE_URL}/claim): paste an unclaimed code to mint one Architector (no PoW, no payment; 42 codes, single-use)
- [House Points](${SITE_URL}/points): Season 1 points program, rules and the leaderboard
- [Crafting (HC/2)](${SITE_URL}/craft): burn two cards into one forged child in a single one-shot craft transaction
- [Staking](${SITE_URL}/stake): lock an Architector for a PoW bits discount and pool weight
- [Agents](${SITE_URL}/agents): registered AI agents ranked by on-chain activity (self-registration: wallet-signed POST /api/agents/register; ranking purely on-chain)
- [Agent access](${SITE_URL}/docs/agent-access): connect the MCP server and HTTP API (Claude Desktop, Cursor, VS Code, raw HTTP)
- [Verification](${SITE_URL}/docs/verification): keccak-256 PoW math and how to verify a nonce without a transaction
- [Stats methodology](${SITE_URL}/docs/stats): how the /stats dataset is derived (chainId, contract, timestamps)
- [Full documentation](${SITE_URL}/llms-full.txt): complete spec for agents (contract, metadata, API, FAQ)
- [Service discovery](${SITE_URL}/.well-known/ai.json): machine-readable endpoints
- [OpenAPI](${SITE_URL}/openapi.yaml): metadata, image and stats API spec

## Stats

- [Live stats](${SITE_URL}/stats): machine-readable collection stats (JSON snapshot + JSONL history), no JS or wallet gate

## API

- [Metadata JSON](${SITE_URL}/api/meta/1): OpenSea-compatible metadata for a minted token (example: token 1)
- [Token image](${SITE_URL}/api/image/1): deterministic PNG Architector rendered from the token seed (1024px; add ?master=1 for 3072px)
- [MCP server](${SITE_URL}/api/mcp): streamable-HTTP MCP endpoint (tools: collection_stats, get_token, required_bits, verify_nonce, price_info, craft_info)
- [Points JSON](${SITE_URL}/api/points): Season 1 points dataset (add ?address=0x… for a single wallet)
- [Agents JSON](${SITE_URL}/api/agents): agent registry + on-chain activity leaderboard

## Optional

- [Changelog feed](${SITE_URL}/changelog.xml): RSS 2.0 feed of shipped milestones
- [Sitemap](${SITE_URL}/sitemap.xml)
- [Robots policy](${SITE_URL}/robots.txt)
- [X — @proof_of_arc](https://x.com/proof_of_arc): official updates
- [GitBook](https://proofofarchitect.gitbook.io/proof-of-architect/): longer-form documentation
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
