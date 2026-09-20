# For AI Agents

This page is the machine-readable surface of Proof of Architect. It lists the stable endpoints you can read and the tools you can call.

## Canonical facts

- Name: **Proof of Architect**; symbol **PARC**.
- Chain: **Arc** — chainId **5042002**.
- Core contract (Arc, v3.2): `0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b` — symbol **PARC**, supply **15,042**, verified on arcscan.
- Gas token: native **USDC**, 18 decimals. `maxFeePerGas` below 20 gwei is silently dropped.
- Supply: **15,042** = 42 free claims + 15,000 paid across 15 waves of 1,000.
- Price: `1.0 USDC × 2^(wave − 1)` base, no cap; a **2.5% mint fee** (`mintFeeBps` 250) is added on top — the exact amount required is `currentMintDue()`.
- PoW: `keccak256(chainId, contract, miner, nonce)`; valid when leading zero bits ≥ `requiredBits(miner)`. Nonces are single-use per wallet.

## Machine-readable surface

- `https://proofofarchitect.builders/llms.txt` — map for LLM agents.
- `https://proofofarchitect.builders/llms-full.txt` — complete specification.
- `https://proofofarchitect.builders/index.md` — collection overview.
- `https://proofofarchitect.builders/mine.md` — mining guide.
- `https://proofofarchitect.builders/.well-known/ai.json` — service discovery.
- `https://proofofarchitect.builders/openapi.yaml` — OpenAPI spec for the metadata/image API.

## Free claim codes

Free claims are a separate path from paid mining. One function drives them:

- `claim(bytes32 code)` — payable, but **must be sent with 0 value**. No proof of work and no payment; gas only.
- The contract stores only `keccak256(code)` hashes (the owner pre-loads them via `addCodes`). Each code is **single-use**, and anyone holding an unclaimed code can redeem it — treat codes as secrets.
- On success the token mints to `msg.sender` with seed `keccak256("claim", chainid, contract, sender, code)`, and the token is flagged free (`isFreeToken`).
- Free tokens are **non-transferable until wave 5** (`LOCK_WAVES = 5`); burning is allowed.
- Reads: `freeClaims()`, `claimsLeft()`, `codesAvailable()`, `claimedCount()`. Event: `Claimed(address indexed miner, uint256 indexed tokenId, bytes32 codeHash)`.
- Claim page for humans: **https://proofofarchitect.builders/claim**.

## MCP endpoint

A remote MCP endpoint is available at `https://proofofarchitect.builders/api/mcp` with read-only tools:

| Tool | Purpose |
|---|---|
| `collection_stats` | Total minted, max supply, claims left, current wave, current price, base bits, paused flag. |
| `get_token` | Owner, seed, nonce, and metadata/image URLs for a token. |
| `required_bits` | Current difficulty for a wallet (wave base + regulator + streak). |
| `verify_nonce` | Recompute a nonce locally and compare it to the target, without a transaction. |
| `price_info` | Current wave, current price, and the full schedule. |
| `verify_rarity` | Recompute a token's OpenRarity information-content score and tier from its on-chain seed. |
| `craft_info` | CraftingController parameters (craftFee, per-tier boostCost/feeFor, windows) and the salt policy. |
| `verify_craft_commit` | Check a craft commit: recompute keccak256(abi.encode(choices, salt)) and compare with the on-chain hash. |

A standalone **stdio MCP server** exposing the same read-only surface is published in the repository.

## Verifying a nonce locally

You do not need to trust the project or send a transaction to verify a mined nonce. Recompute the keccak-256 hash of `(chainId, contract, miner, nonce)` and check the leading zero bits against `requiredBits`. The `verify_nonce` tool does exactly this.

## Official links

- Website: **https://proofofarchitect.builders**
- X (Twitter): **https://x.com/proof_of_arc**
- GitBook: **https://proofofarchitect.gitbook.io/proof-of-architect/**

## Notes

- All tools are read-only. Nothing on this surface can change state.
- Difficulty, price, and supply are all readable directly on-chain.
- Traits derive deterministically from the on-chain seed, so any token's card can be recomputed by anyone.
