import { SITE_URL } from "@/lib/site";
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

> Proof-of-work minted NFT collection on Arc (Circle L1, chainId 5042002). Mine a keccak-256 nonce in the browser or on GPU — the winning hash becomes the token's on-chain seed and the Architector art derives from it deterministically. 42 free claim codes and 15,000 paid mints across 15 waves; the paid price is 1.0 USDC at wave 1, doubling every wave with no cap, paid as native gas token USDC (a 2.5% mint fee is added on top; total due = currentMintDue()).

Key facts:
- Contract (ERC-721, symbol PARC): 0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b (Arc, v3.2, verified on arcscan; a 2.5% mint fee is added on top of the wave price at mint)
- Mining formula: work = keccak256(abi.encodePacked(chainId, contract, miner, nonce)); valid when leading zero bits of work >= requiredBits
- Difficulty has three layers: a wave base (baseBits 30 + 2 per wave), a load regulator, and a per-wallet streak
- Art is an "Architector": 10 rendered pixel layers + a golden overlay + 4 metadata-only slots, all derived from the seed
- Difficulty, price and supply are readable on-chain; nonces can be verified without a transaction
- Free claims: 42 one-time codes — claim(bytes32 code) with 0 value, no proof of work and no payment (gas only); claimed tokens are non-transferable until wave 5
- Crafting (HC/2): forge one child card from two you own via two-phase commit/reveal. slotChoicesHash = keccak256(abi.encode(choices, bytes32 salt)); the salt is a per-commit 32-byte client secret (never publish it before reveal, never use 0). Reveal window is [commit+3, commit+258] blocks, entropy = blockhash(commit+2); miss the window or lose the salt and only refund() remains (cards back; fee kept unless the forge is paused). Controller: ${CRAFT_ADDRESS ?? "(not deployed — set NEXT_PUBLIC_CRAFT_ADDRESS)"}. Full flow in the "Crafting (HC/2)" section of llms-full.txt.
- Staking: lock an Architector for 0/7/30/90/180/365 days (tiers 0..5) for a PoW bits discount (2/2/4/4/6/6) and pool weight (0.1/0.5/1/2/3/4×). Staking is a HARD LOCK: a staked card stays in the vault until the end of the chosen term and cannot be withdrawn earlier (unstake reverts Locked(until) while now < stakedAt + lockDays(tier)·86400; no emergency exit, no cooldown). Tier 0 (0 days) is flexible and can be unstaked at any time. Vault: ${VAULT_ADDRESS ?? "(not deployed — set NEXT_PUBLIC_VAULT_ADDRESS)"}. Full flow in the "Staking" section of llms-full.txt.
- House Points (Season 1): points for mine (+100), free claim (+50), craft/forge (+150), burn (+30) — derived from on-chain events, planned to convert into future PARC rewards (subject to change; no guarantees)

## Docs

- [Collection overview](${SITE_URL}/index.md): mechanics, economics, Architector traits, determinism
- [Mining guide](${SITE_URL}/mine.md): how to mine a nonce and mint safely
- [Free claim codes](${SITE_URL}/claim): paste an unclaimed code to mint one Architector (no PoW, no payment; 42 codes, single-use)
- [House Points](${SITE_URL}/points): Season 1 points program, rules and the leaderboard
- [Crafting (HC/2)](${SITE_URL}/craft): forge one child card from two you own (commit/reveal with a secret salt)
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
- [MCP server](${SITE_URL}/api/mcp): streamable-HTTP MCP endpoint (tools: collection_stats, get_token, required_bits, verify_nonce, price_info, verify_rarity, craft_info, verify_craft_commit)
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
