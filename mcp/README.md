# arc-pow-sigils-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server
for the **Proof of Architect** NFT collection (House Card art) — a proof-of-work
minted NFT on **Arc testnet** (chainId `5042002`, native gas token **USDC**, 18 decimals).

The server exposes **read-only** tools over the deployed `PowMintNFTv3` contract so an
LLM agent can inspect collection stats, token data, PoW difficulty and pricing — and
even **verify a mined nonce without sending a transaction**.

- Contract (v3.2 testnet): `0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b` (mainnet TBD; override via `CONTRACT_ADDRESS`)
- RPC: `https://rpc.testnet.arc.io` (override via `ARC_RPC_URL`)
- Transport: **stdio** (newline-delimited JSON-RPC)

---

## Quick start

### Run with npx (after publishing)

```bash
npx arc-pow-sigils-mcp
```

### Run from source

```bash
npm install
npm run build      # tsc -> dist/
npm run smoke      # spawns the server and hits the live chain
node dist/index.js # start the stdio server
```

The server speaks MCP over stdin/stdout and logs only to stderr — it is normally
launched by an MCP client, not by hand.

---

## Use in Claude Desktop

Add this to your `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "arc-pow-sigils": {
      "command": "npx",
      "args": ["-y", "arc-pow-sigils-mcp"],
      "env": {
        "SITE_URL": "https://proofofarchitect.builders"
      }
    }
  }
}
```

Or, pointing at a local build:

```json
{
  "mcpServers": {
    "arc-pow-sigils": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "CONTRACT_ADDRESS": "0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b",
        "ARC_RPC_URL": "https://rpc.testnet.arc.io",
        "SITE_URL": "https://proofofarchitect.builders"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

---

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `collection_stats` | — | `totalMinted`, `maxSupply`, `freeClaims`, `claimsLeft`, `claimedCount`, `currentWave`, `baseBits`, `currentPrice` (wei + USDC), `mintPaused` |
| `get_token` | `tokenId` (number) | `owner`, `seed`, `nonce`, `tokenURI`, off-chain `image` + `metadata` urls. Error content if the token doesn't exist. |
| `required_bits` | `miner` (address) | `bits` (required leading zero bits) + wave/`loadAdjust`/`streakBits` breakdown. Three difficulty layers: base **30 + 2 bits per wave**, a pace regulator, and a per-wallet streak (+2 bits per extra mint inside the cooldown window = 60 s × wave). |
| `verify_nonce` | `miner` (address), `nonce` (uint256 decimal string) | `work`, `leadingZeroBits`, `requiredBits`, `valid` — verifies a mined nonce **without a transaction**. |
| `price_info` | — | `currentPrice` + wave math (epoch size `1000`, `priceStart` `1.0 USDC`, `x2` per wave, **no cap** — 15 waves, last wave 16 384 USDC). |
| `craft_info` | — | CraftingController v1 config: `paused`, `craftFee`, per-tier `boostCost`/`feeFor`/`maxChosen` (tiers 0..3), `committedFees`, `lastCommitId`, the reveal window constants (`ENTROPY_DELAY`, `MIN_REVEAL_DELAY`, `REVEAL_WINDOW`) and the salt policy (commit-reveal crafting). |
| `verify_craft_commit` | `commitId` (number), `choices` (`[slot, parent]` pairs), `salt` (`0x` + 64 hex) | Recomputes `keccak256(abi.encode(choices, salt))` and compares it to the on-chain `choicesHash` → `match`, plus `settled` flags, `player`, `boostTier` and the reveal `window` — **without a transaction**. |

All tools return a single JSON text content block. `verify_nonce` recomputes the
preimage hash locally as
`keccak256(abi.encodePacked(chainId, contract, miner, nonce))` and counts leading
zero bits itself, so it does not trust the RPC for the PoW verdict.

### Example: verify a mined nonce (v2 instance — historical)

```json
{
  "miner": "0x1111111111111111111111111111111111111111",
  "nonce": "403415",
  "work": "0x00000dcc59e937a8228cb92d216aeb3705bd3c4d1dff61fa648d1d603777f5bf",
  "workMatchesOnChain": true,
  "leadingZeroBits": 20,
  "requiredBits": 24,
  "valid": false
}
```

Call it as `verify_nonce(miner = "0x1111111111111111111111111111111111111111", nonce = "403415")`.
The PoW formula is unchanged in v3 — the contract address only binds the preimage, so the
same call works against v3 with nonces mined for that address.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTRACT_ADDRESS` | `0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b` | PowMintNFTv3 address (mainnet TBD) |
| `CRAFT_ADDRESS` | `0xF3E861085D5569d3eb376277a3F3D87579E94b09` | CraftingController v1 address (commit-reveal crafting) |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.io` | Arc testnet RPC endpoint |
| `SITE_URL` | `https://proofofarchitect.builders` | Base site for `/api/image/{id}` and `/api/meta/{id}` links |

All variables are optional. No secrets are read or stored.

---

## Publish to the MCP registry

1. **Replace the placeholders.** The official
   [MCP registry](https://registry.modelcontextprotocol.io) requires a reverse-DNS
   server name that includes your GitHub username — for this project:
   `Proofofarchitect`. Replace `io.github.YOUR-GITHUB-USERNAME` in **both**
   `package.json` (`mcpName` field) and `server.json` (`name` field) with
   `io.github.Proofofarchitect/...`, and fix `server.json` `repository.url`
   (`YOUR-GITHUB-USERNAME` → `Proofofarchitect`).

2. **Publish the npm package** (the registry resolves the stdio package by name):

   ```bash
   npm run build
   npm publish --access public
   ```

3. **Install the registry publisher CLI** and publish the server metadata:

   ```bash
   npx @modelcontextprotocol/mcp-publisher --help

   npx @modelcontextprotocol/mcp-publisher init      # scaffolds/validates server.json
   npx @modelcontextprotocol/mcp-publisher login github   # auth with your GitHub account
   npx @modelcontextprotocol/mcp-publisher publish   # publishes server.json
   ```

   The publisher verifies that the `name` namespace matches your authenticated
   GitHub identity (that is why the placeholder must be replaced).

4. **Verify** on the registry at
   [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io).
   New entries are served with **preview** status while the registry is in preview.

> Keep `package.json` `version` and `server.json` `version` (and the package
> `version` field) in lockstep on every release.

---

## Development

```
src/chain.ts   viem client singleton, contract read helpers, leadingZeroBits,
               USDC formatting, work/preimage + craft-commit hash helpers
src/index.ts   McpServer + 7 registered tools over StdioServerTransport
smoke.mjs      minimal newline-delimited JSON-RPC client used by `npm run smoke`
server.json    MCP registry manifest (npm stdio)
```

The ABI is embedded in this package (see `src/chain.ts`) — it is not imported from
the website package, so `mcp/` stays independently publishable.

## License

MIT
