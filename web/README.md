# Arc PoW Sigils — web frontend (MVP)

Next.js (App Router, TypeScript) frontend for the **PowMintNFT** collection on
Arc. Reads the contract with [viem]; the art/metadata layer renders
deterministic **ARC-traits/2** PNGs (15 seed-derived slots, native 1254×1254) +
OpenSea JSON from each token's on-chain seed.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- viem 2 (chain definition, reads, writes)
- Plain CSS (`app/globals.css`), no Tailwind

## Environment variables

Copy `.env.local.example` to `.env.local` and adjust if needed:

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.testnet.arc.io` | Arc testnet JSON-RPC endpoint |
| `NEXT_PUBLIC_CONTRACT_ADDRESS` | `0x8f5795343C10b316296f6767a10e87CC40E62491` | PowMintNFT v3.4 address override |
| `NEXT_PUBLIC_MIN_MAX_FEE_GWEI` | `50` | Minimum `maxFeePerGas` in gwei (floor is 20; Arc drops txs below) |
| `NEXT_PUBLIC_SITE_URL` | `https://proofofarchitect.builders` | Canonical public URL for sitemap/llms.txt/JSON-LD/OpenAPI — **set before deploy** |

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
| `/token/[id]` | Token detail — owner, seedOf, nonceOf, workFor, tokenURI, image, all ARC-traits traits |
| `/api/meta/[id]` | OpenSea-compatible metadata JSON (ARC-traits from the on-chain seed) |
| `/api/image/[id]` | Deterministic ARC-traits PNG rendered from the on-chain seed (1254×1254; `?master=1` → 3762×3762) |
| `/api/mcp` | Remote MCP server (streamable HTTP) — 6 read-only collection tools |
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
- Metadata + image API routes: real `seedOf` read → canonical ARC-traits
  derivation (`lib/prng.ts`, `lib/traits_v2.ts`) → OpenSea JSON / composited PNG.
- `/mine`: wallet connect via injected `window.ethereum`, chain switch/add for
  Arc, one-click **Start mining** (real PoW web worker) → live stats
  (hashes / H/s / elapsed / best bits) → auto-stop when a nonce clears the
  on-chain `requiredBits`, local re-verification, then `mint(nonce)` with
  `maxFeePerGas = max(50 gwei, 2× baseFee)` (never below 20 gwei) and
  `value == currentMintDue().due`, followed by a receipt wait and stats refresh.
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
- **`setBaseURI` re-point**: `tokenURI` returns
  `https://proofofarchitect.builders/api/meta/<id>`. Until it is re-pointed at
  this deployment's `/api/meta/`, the UI uses the local `/api/image/[id]` route
  directly, which is seed-derived and always correct.
- **Art factory cross-check**: metadata/art traits follow the artist
  **ARC-traits/2** spec (`art/v2/spec.json` + `art/v2/vectors_traits.json`) and
  are a faithful port of `art/arc-traits/tools/v2lib.py`. Parity is asserted by
  `npm run check:traits2` (5 seeds × 15 slots); the legacy house-card/1 set is
  still gated by `npm run check:traits`. Re-run after any trait/weight change.
- **WalletConnect / wallet-agnostic connect (later)**: `/mine` currently relies
  on an injected EIP-1193 provider (`window.ethereum`, e.g. MetaMask). Mobile /
  WalletConnect support is intentionally deferred; wire it in without changing
  the mining or mint path.

## ARC-traits/2 renderer

The live art stack is the artist **ARC-traits/2** set (15 slots), a byte-for-byte
semantic port of `art/arc-traits/tools/v2lib.py` on `art/v2/spec.json`. Set
`NEXT_PUBLIC_TRAITS_SET=v2` and the client (token page) and the server
(`/api/meta`, `/api/image`) agree on the set; anything else renders the legacy
house-card/1 set (`lib/traits.ts` + `lib/renderer.ts`), whose assets stay in
`public/traits` for rollback.

- **Derivation:** `lib/traits_v2.ts` — the same PRNG machinery as house-card/1
  (per-slot keccak256 word streams + rejection-sampled weighted pick). PNG
  composition lives in `lib/renderer_v2.ts` (server-side `sharp`).
- **Slots (15):** `background, head, outfit, hair, eyes, nose, mouth, eyewear,
  headwear, companion` (10 rendered layers) plus `hair_color` — a render
  modifier that selects `hair-colors/<color>/<style>.png` (fallback
  `hair/<style>.png`) — and 4 metadata-only text rows (`era, origin, quote,
  lore`). `head` is the base character (replaces v1's body species).
- **Assets:** served from `web/public/traits-v2/`; every layer is a full
  1254×1254 PNG. `None` values and missing files are skipped, so a partial tree
  still renders. Nose/mouth for the Ice/Pale/Reptile heads resolve through
  `head-variants/<head>/<slot>/<value>.png` when present.
- **Sizes:** native canvas is **1254×1254**; `?master=1` emits the
  **3762×3762** master (×3 exact). Same seed → byte-identical output.
- **No golden/bug:** v2 drops the v1 golden/bug conditional rules. The rare gold
  pieces are ordinary weighted values instead — headwear `Gold Kippah` and
  companion `Gold Fly`, 0.5% each (spec v2.3).
- **Preview mode:** until real mints fill the grid, the collection/token pages
  can render deterministic preview cards for ids 1..N — set
  `NEXT_PUBLIC_PREVIEW_CAP=N` (0 = off, the production default; the testnet
  deployment runs 24). Minted tokens always win over previews.
- **Cross-check gate:** `npm run check:traits` asserts `lib/traits.ts` (v1) and
  `npm run check:traits2` asserts `lib/traits_v2.ts` against
  `art/v2/vectors_traits.json` (5 seeds × 15 slots). Treat a red gate as a
  build blocker.

## Deploy notes

- Deployable to Vercel as-is. Set the three `NEXT_PUBLIC_*` env vars in the
  project settings for a custom RPC/contract.
- API routes use `runtime = "nodejs"` and `dynamic = "force-dynamic"`; they call
  Arc RPC per request (60s in-memory cache).
- Once live, point the contract's `setBaseURI` at
  `https://<deployment>/api/meta/` so marketplaces resolve metadata here.
- **AI-discoverability**: set `NEXT_PUBLIC_SITE_URL` before deploying, then run
  `bash ops/ai_discovery/activate.sh https://<domain> [--send]` (probe 10/10 + IndexNow).
  Full launch order — `launch runbook` §4; design notes — `discovery notes`.

[viem]: https://viem.sh
