# Proof of Architect

**Proof of Architect** is a proof-of-work NFT project on **Arc** (Circle's EVM L1; gas and payments in native USDC).

Cards — **Architectors** — are mined, not distributed: a miner searches for a `nonce` such that

```
keccak256(chainId ‖ contract ‖ miner ‖ nonce)
```

has a required number of leading zero bits. The winning hash becomes the token's on-chain **seed**; all art and traits are derived deterministically from that seed off-chain. The contracts store nothing but the seed.

**Collection:** 15,042 cards — 42 free claim codes + 15,000 paid mints across 15 waves of 1,000 (base price starts at 1 USDC and doubles every wave; +2.5% mint fee).

**Status:** LIVE on Arc mainnet since 2026-09-21 (chainId 5042). Website: https://proofofarchitect.builders

**Mechanics:** mining (CPU/GPU), claim codes, staking (hard-lock), crafting (one-shot 2→1, fixed 5 USDC fee — no commit–reveal).

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project — core NFT (v3.4) + `StakingVaultV2`, `CraftingControllerV2`, rarity registry, rewards, burn points (Solidity 0.8.26) |
| `web/` | Next.js site: mining UI (CPU + WebGPU), collection, claim/stake/craft, deterministic metadata/image API, MCP endpoint |
| `miner/` | Dependency-free browser JS Keccak-PoW miner (Web Worker) |
| `mining/gpu/` | CUDA miner |
| `mcp/` | Standalone MCP server for AI agents (read-only tools: stats, tokens, nonce verification, craft config) |
| `art/v2/` | Canonical layer set for the deterministic renderer (v2.3, 122 PNG, 15 slots) |
| `art/canon/` | Frozen art anchors + legendary chips |
| `examples/` | Agent/crafting examples |

## Contracts (Arc mainnet, chainId 5042)

| Role | Address |
|---|---|
| Core — `PowMintNFTv3_4` | `0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4` |
| `StakingVaultV2` | `0xEa9dD5BD05922878A93e2F67bd457D2bBad5BE83` |
| `CraftingControllerV2` | `0xb7f32811F19579D9FC6F0e5ac925473554091a91` |
| `RarityRegistry` | `0x09699f496572a4288b0d9e3b436936f89142624b` |
| `StakeRewards` | `0xbe1bb857d3653beacd2f56e395b1ada3f4f4a49e` |
| `BurnPoints` | `0x7bb5fa517745302b1d44eac458f55c1eeb6675b5` |

Live on Arc mainnet since 2026-09-21 (core deployed at block 22030776, craft at 22030850); explorer: https://explorer.arc.io. The single source of truth for these addresses is `web/lib/canonical.ts`. Contract suite: **350/350** (unit + fuzz + invariant tests).

## Quick start

- **Contracts:** `cd contracts && forge build && forge test`
- **Web:** `cd web && npm install && npm run dev` (environment variables — see `web/README.md`)
- **Miner:** open `miner/test.html` locally, or use the GPU miner in `mining/gpu/`
- **MCP:** `cd mcp && npm install && npm run build`

## Links

- Website: https://proofofarchitect.builders
- X: https://x.com/proof_of_arc
- Docs: https://proofofarchitect.gitbook.io/proof-of-architect/
- MCP server: https://github.com/Proofofarchitect/arc-pow-sigils-mcp
- For agents: [AGENTS.md](AGENTS.md)

## Security

Vulnerability reports are welcome — see [SECURITY.md](SECURITY.md). Please report privately, not via public issues.

## License

Code is released under the [MIT License](LICENSE). Artwork and brand assets may carry separate terms.

*Tokens are collectibles: no promised value, not investment advice. See the website Legal page.*
