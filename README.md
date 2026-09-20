# Proof of Architect

**Proof of Architect** is a proof-of-work NFT project on **Arc** (Circle's EVM L1; gas and payments in native USDC).

Cards — **Architectors** — are mined, not distributed: a miner searches for a `nonce` such that

```
keccak256(chainId ‖ contract ‖ miner ‖ nonce)
```

has a required number of leading zero bits. The winning hash becomes the token's on-chain **seed**; all art and traits are derived deterministically from that seed off-chain. The contracts store nothing but the seed.

**Collection:** 15,042 cards — 42 free claim codes + 15,000 paid mints across 15 waves of 1,000 (base price starts at 1 USDC and doubles every wave; +2.5% mint fee).

**Mechanics:** mining (CPU/GPU), claim codes, staking (hard-lock), crafting (2→1, commit–reveal with on-chain entropy).

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project — core NFT + staking vault, crafting controller, rarity registry, rewards, burn points (Solidity 0.8.26) |
| `web/` | Next.js site: mining UI (CPU + WebGPU), collection, claim/stake/craft, deterministic metadata/image API, MCP endpoint |
| `miner/` | Dependency-free browser JS Keccak-PoW miner (Web Worker) |
| `mining/gpu/` | CUDA miner |
| `mcp/` | Standalone MCP server for AI agents (read-only tools: stats, tokens, nonce verification, craft checks) |
| `art/v2/` | Canonical layer set for the deterministic renderer (120 PNG, 15 slots) |
| `gitbook/` | Public documentation source (EN) |
| `examples/` | Agent/crafting examples |

## Contracts (Arc testnet, chainId 5042002)

| Role | Address |
|---|---|
| Core — `PowMintNFT` (v3.2) | `0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b` |
| `StakingVault` | `0x7501e5dA268ab93c1f1A8467095Cd9FFe9734CfD` |
| `CraftingController` | `0x1542c820cF8644Abb91BF5c275097f89578FC3A9` |
| `RarityRegistry` | `0x9Ce1cD8d4bDcba89a2be6E0021fD073dDdA3cD47` |
| `StakeRewards` | `0x593973ce94a82282a7d6f4bbf384ccd852d160a1` |
| `BurnPoints` | `0xD964C910dDa776dA55a900F85B019f48C237EA8b` |

Mainnet addresses will be published after deployment. Contract suite: **333/333** (unit + fuzz + invariant tests).

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
