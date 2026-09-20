# Arc PoW Sigils — web frontend (MVP)

Next.js (App Router, TypeScript) frontend for the **PowMintNFT** collection on
Arc testnet. Reads the contract with [viem]; the art/metadata layer renders
deterministic **House Card** PNGs (15 seed-derived slots) + OpenSea JSON from
each token's on-chain seed.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- viem 2 (chain definition, reads, writes)
- Plain CSS (`app/globals.css`), no Tailwind

## Environment variables

Copy `.env.local.example` to `.env.local` and adjust if needed:

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.testnet.arc.io` | Arc testnet JSON-RPC endpoint |
| `NEXT_PUBLIC_CONTRACT_ADDRESS` | `0xc7D2C2cC9291485ec8B727333B6a1478Dd66c3D5` | PowMintNFT v2 address override |
| `NEXT_PUBLIC_MIN_MAX_FEE_GWEI` | `25` | Minimum `maxFeePerGas` in gwei (floor is 20; Arc drops txs below) |
| `NEXT_PUBLIC_SITE_URL` | `https://powcats.example` | Canonical public URL for sitemap/llms.txt/JSON-LD/OpenAPI — **set before deploy** |

All are optional — sane Arc defaults are baked in, so the app boots with no env.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm start        # serve the production build
```

## Routes

| Route | Description |
|---|---|
| `/` | Collection — grid of minted tokens (totalMinted/maxSupply/price header) |
| `/mine` | Connect wallet, live difficulty/price, Mine (worker) + Mint |
| `/token/[id]` | Token detail — owner, seedOf, nonceOf, workFor, tokenURI, image, all House Card traits |
| `/api/meta/[id]` | OpenSea-compatible metadata JSON (House Card traits from seed) |
| `/api/image/[id]` | Deterministic House Card PNG rendered from the on-chain seed (`?master=1` → 3072×3072) |
| `/api/mcp` | Remote MCP server (streamable HTTP) — 5 read-only collection tools |
| `/robots.txt` | Everyone welcome — no crawler blocks (owner policy); AI bots explicitly listed + sitemap ref |
| `/sitemap.xml` | Pages + one URL per minted token (read from chain, ISR 10 min) |
| `/llms.txt`, `/llms-full.txt` | llms.txt v2 map + full agent documentation |
| `/index.md`, `/mine.md` | Markdown page versions (advertised via `Link: rel=alternate`) |
| `/.well-known/ai.json` | Service discovery for AI agents (endpoints, contract, MCP tools) |
| `/openapi.yaml` | OpenAPI 3.0 spec for the metadata/image API |

## What is stubbed vs working

**Working (real contract reads/writes):**
- Chain config, contract ABI, all views (`currentPrice`, `requiredBits`,
  `totalMinted`, `maxSupply`, `freeSupply`, `ownerOf`, `tokenURI`, `seedOf`,
  `nonceOf`, `mintPaused`).
- Metadata + image API routes: real `seedOf` read → canonical House Card trait
  derivation (`lib/prng.ts`, `lib/traits.ts`) → OpenSea JSON / composited PNG.
- `/mine`: wallet connect via injected `window.ethereum`, chain switch/add for
  Arc, one-click **Start mining** (real PoW web worker) → live stats
  (hashes / H/s / elapsed / best bits) → auto-stop when a nonce clears the
  on-chain `requiredBits`, local re-verification, then `mint(nonce)` with
  `maxFeePerGas = max(50 gwei, 2× baseFee)` (never below 20 gwei) and
  `value == currentPrice()`, followed by a receipt wait and stats refresh.
  Manual-nonce minting also works.

**Miner worker — installed and verified:**
- `public/miner/miner-worker.js` is a **byte-identical copy** of the verified
  `miner/miner-worker.js`; the typed main-thread wrapper is
  `lib/miner-client.ts`. The `/mine` page spawns the worker, streams
  `progress` messages, and re-verifies every candidate with `lib/pow.ts` before
  offering it to `mint()`. The worker is dependency-free Keccak-256; its
  in-page self-test passes 5/5 in headless Chromium (see
  `public/miner/README.md` for the real message protocol — it differs from the
  original placeholder contract: the worker does **not** take `requiredBits`
  and emits `progress`/`done`, not `found`).
- To update the worker: edit `miner/miner-worker.js`, then re-copy it into
  `public/miner/` so the served copy stays byte-identical to the tested one.

**Stubbed / pending:**
- **`setBaseURI` re-point**: `tokenURI` currently returns
  `https://powcats.example/api/meta/<id>` (placeholder). The owner will re-point
  it to this deployment's `/api/meta/` later. Until then the UI uses the local
  `/api/image/[id]` route directly, which is seed-derived and always correct.
- **Art factory cross-check**: metadata/art traits now follow the canonical
  **House Card** spec (`art/spec.json` + `art/test_vectors.json`) and are a
  faithful port of `art/pipeline.py`. Parity is asserted by `npm run check:traits`
  (5 seeds × 15 slots + golden flag). Re-run it after any trait/weight change.
- **WalletConnect / wallet-agnostic connect (later)**: `/mine` currently relies
  on an injected EIP-1193 provider (`window.ethereum`, e.g. MetaMask). Mobile /
  WalletConnect support is intentionally deferred; wire it in without changing
  the mining or mint path.

## House Card renderer

The art stack is the **House Card** system (15 slots), a byte-for-byte semantic
port of `art/pipeline.py`. Derivation lives in `lib/traits.ts` (identical PRNG,
per-slot counter reset, integer weights ×10 from `art/spec.json`); PNG
composition lives in `lib/renderer.ts` (server-side `sharp`).

- **Assets:** real art ships from **`web/public/traits/<slot>/<slug>[__<body>].png`**
  (slot = spec slot name, slug = kebab-case value: `Reverse Cap 404` →
  `reverse-cap-404`). Head slots (`face`/`eyes`/`headwear`) carry per-body
  variants (`<slug>__guy|girl|reptile|alien.png`); the compositor prefers the
  variant of the card's body and falls back to the flat file. Source of truth
  and served copy are kept identical: `art/assets/` ⇄ `web/public/traits/`
  (rebuilt from the accepted layer catalog `art/svg/catalog/layers_png` via
  `import_catalog.py`). `None` values and missing files are skipped, so a
  partial tree still renders; the two parked backgrounds (Testnet Grid, Faucet
  Screen) fall back to House Grid until their concepts land.
- **Sizes:** real masters are 128×128. The compositor works at native 512
  (×4 nearest — pixel-exact) and upscales with a nearest kernel —
  **1024×1024** by default and **3072×3072** for `?master=1` (OpenSea requires
  masters **≥3000**). Same seed → byte-identical output.
- **Golden overlay:** `golden` is a flag overlay (`public/traits/golden/<slug>.png`,
  event ∈ `House Cat`/`Fat Rat`), composited **last** over the normal stack.
  It only fires when `legendary == None`; metadata adds
  `{ trait_type: "Golden", value: "Yes" }` when true.
- **Preview mode:** until real mints fill the grid, the collection/token pages
  can render deterministic preview cards (`keccak256("poa-preview" ‖ id)`) for
  ids 1..N — set `NEXT_PUBLIC_PREVIEW_CAP=N` (0 = off, the production default;
  the testnet deployment runs 24). Minted tokens always win over previews.
  Preview cards keep outfit/face/headwear/eyes/backgrounds and exclude only
  the noise animations — companion animals, tool artifacts and bugs (plus
  cat/rat golden events) via `lib/preview.ts` — preview-only, the canon spec
  and real mints are untouched. The body (personality) is cycled across the
  four species (Builder/Clerk/Architect/Shadow) so every character is
  represented.
- **Cross-check gate:** `npm run check:traits` asserts `lib/traits.ts` against
  `art/test_vectors.json` (5 seeds × 15 slots + golden). Treat a red gate as a
  build blocker.

## Deploy notes

- Deployable to Vercel as-is. Set the three `NEXT_PUBLIC_*` env vars in the
  project settings for a custom RPC/contract.
- API routes use `runtime = "nodejs"` and `dynamic = "force-dynamic"`; they call
  Arc RPC per request (60s in-memory cache).
- Once live, point the contract's `setBaseURI` at
  `https://<deployment>/api/meta/` so marketplaces resolve metadata here.
- **AI-discoverability**: set `NEXT_PUBLIC_SITE_URL` before deploying, then run
  `bash repo tooling https://<domain> [--send]` (probe 10/10 + IndexNow).
  Full launch order — `launch runbook` §4; design notes — `discovery notes`.

[viem]: https://viem.sh
