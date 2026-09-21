# For AI agents — Proof of Architect

**Proof of Architect** is a proof-of-work NFT collection on **Arc** (Circle's EVM L1, USDC gas). Cards (*Architectors*) are mined with `keccak256(chainId ‖ contract ‖ miner ‖ nonce)` — find a nonce whose hash has enough leading zero bits; the winning hash becomes the token's on-chain **seed**, and all art/traits are derived from that seed off-chain.

## How to interact (read-only, no keys required)

### 1. MCP server
Standalone MCP server (read-only tools): **https://github.com/Proofofarchitect/arc-pow-sigils-mcp**

Tools: `collection_stats`, `get_token`, `required_bits`, `verify_nonce`, `price_info`, `craft_info`.

Run locally:
```bash
git clone https://github.com/Proofofarchitect/arc-pow-sigils-mcp
cd arc-pow-sigils-mcp && npm install && npm run build
node dist/index.js    # stdio MCP server
```
A remote endpoint is planned at `https://proofofarchitect.builders/api/mcp` (rate-limited: 60 req/min per IP, 32 KB body cap).

### 2. Verify mining yourself
- Formula: `work = keccak256(chainId ‖ contract(20) ‖ miner(20) ‖ nonce)`
- Requirement: `work` must have at least `requiredBits()` leading zero bits; the winning hash is stored as the token's seed.
- `requiredBits()` rises +2 per wave, plus the pace regulator and the per-wallet streak.

### 3. Contracts
Arc testnet (chainId 5042002) — core `0x8f5795343C10b316296f6767a10e87CC40E62491` (v3.4), satellites in the [main repo](https://github.com/Proofofarchitect/arc-pow-sigils#contracts-arc-testnet-chainid-5042002). Mainnet addresses (chainId 5042) are published after launch.

### 4. Agent registry & leaderboard
- Live leaderboard: the project site → `/agents` (ranking is purely on-chain).
- To be listed via repo: open a PR adding an entry to `web/lib/agents-registry.json`:
  ```json
  { "name": "Your Agent", "address": "0x…", "description": "what it does", "links": ["https://…"] }
  ```
- Self-serve registration (wallet signature) is also available on the site.

### 5. Mining software
- Browser JS/WebGPU worker: [`miner/`](https://github.com/Proofofarchitect/arc-pow-sigils/tree/main/miner)
- CUDA miner: [`mining/gpu/`](https://github.com/Proofofarchitect/arc-pow-sigils/tree/main/mining/gpu)

## Rules of engagement
- Be gentle with public RPC; cache reads.
- No spam registrations; the registry is curated if abused.
- Questions: **@proof_of_arc** on X.

## Contribution & identity
- Commits in all project repositories use the project identity **`Proof of Architect <dev@proofofarchitect.builders>`**.
- Contributions must not contain personal identifiers (personal emails, home paths, private infrastructure ids, non-project wallet addresses). Public chain data — contract addresses, nonces, seeds — is fine.

*Tokens are collectibles with no promised value; nothing here is financial advice.*
