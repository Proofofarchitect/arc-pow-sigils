import { SITE_URL } from "@/lib/site";
import { CANON_CORE } from "@/lib/canonical";
import { ARC_CHAIN_ID } from "@/lib/contract";
import { CRAFT_ADDRESS } from "@/lib/craft";
import { VAULT_ADDRESS } from "@/lib/staking";

/**
 * /llms-full.txt — complete agent-readable documentation.
 * Plain text: no backticks, so it survives any markdown/text pipeline.
 *
 * Craft/stake addresses are read from the same build env the app uses
 * (NEXT_PUBLIC_CRAFT_ADDRESS / NEXT_PUBLIC_VAULT_ADDRESS) and update with the
 * env swap; the placeholder text means "not deployed yet".
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const body = `# Proof of Architect — full documentation

> Proof of Architect is a proof-of-work minted NFT collection on Arc, Circle's EVM L1 with USDC as the native gas token. Instead of buying randomness, holders mine a keccak-256 nonce; the valid nonce's hash is recorded on-chain as the token's seed (seedOf), and the card's art seed derives POST-INCLUSION from it plus a later block hash (keccak256(seedOf ‖ blockhash(mintBlockOf(id) + 2))) — traits are not knowable before the mint. This document is the complete agent-readable reference: contract, mechanics, economics, metadata, HTTP API and MCP tools.
>
> Launch status: LIVE on Arc mainnet since 2026-09-21 (chainId 5042, USDC gas). All pages and APIs are open; /api/image serves a deterministic render.

Canonical URLs
- Site: ${SITE_URL}/
- Index for agents: ${SITE_URL}/llms.txt
- Service discovery: ${SITE_URL}/.well-known/ai.json
- OpenAPI: ${SITE_URL}/openapi.yaml
- MCP endpoint: ${SITE_URL}/api/mcp

## 1. What it is

Each NFT ("Architector") is produced by grinding a nonce until the keccak-256 hash of the preimage below starts with enough zero bits. The winning hash is stored on-chain as the token seed. There is no server randomness and no oracle: art and rarity are a pure, verifiable function of the proof of work.

Difficulty escalates on three independent layers: a per-wave base (baseBits 30 plus 2 bits every wave), a load regulator that tightens or loosens to hold a pace target, and a per-wallet streak inside a wave-scaled cooldown. Supply is 15,042: 42 free claim codes (no PoW, no payment) plus 15,000 paid mints across 15 waves of 1,000. The paid price is 1.0 USDC at wave 1 and doubles every wave with no cap.

## 2. Contract and network

- Network: Arc (chainId ${ARC_CHAIN_ID}; the contract below is the current canonical v3.4 deployment).
- Contract: ${CANON_CORE} — ERC-721 (v3.4), ERC-2981 royalties 5% (500 bps), verified on the Arc explorer (canon v3.4).
- Symbol: PARC.
- Explorer: https://explorer.arc.io/address/${CANON_CORE}
- Gas token: USDC, 18 decimals (native, not ETH). Transactions with maxFeePerGas below 20 gwei are silently dropped by Arc.
- Payment: msg.value must equal currentMintDue().due exactly (= currentPrice() plus a 2.5% mint fee, mintFeeBps=250); the contract reverts with WrongPayment otherwise.
- Supply: maxSupply 15,042 = 42 free claims + 15,000 paid. tokenId = 1..maxSupply. tokenURI(id) = baseURI + id.
- Treasury is immutable (pinned at deployment); royalty receiver is the same treasury.

## 3. Mining mechanics

Preimage (104 bytes):

    work = keccak256(abi.encodePacked(uint256 chainId, address contract, address miner, uint256 nonce))

Validity:

    uint256(work) < targetFor(miner)
    requiredMilli(miner) = per-wallet difficulty in MILLI-BITS (thousandths of a bit); requiredBits(miner) is its display value (ceil)

Difficulty layers (v3.4):
- Wave base: baseBits starts at 30 and rises per wave.
- Load regulator: nudged every 5 mints toward a 25 s/mint pace target; +2 bits when too fast, -1 bit when too slow.
- Per-wallet streak: flat cooldown 5–25 min; extra fast mints add streak bits (+2 each), reset after the cooldown.
- Staking discount: a milli-bit reduction (0/0.5/1.5/3/4.5/6 bits) from a vault lock.

- baseBits is 30 at wave 1 (deployment parameter).
- Nonces are single-use per wallet (nonceUsed[miner][nonce]).
- On success the contract stores seedOf[tokenId] = work and nonceOf[tokenId] = nonce, and emits Mined(miner, tokenId, nonce, work, bits, paid).

Free claims (codes)

- A free claim mints one Architector with no proof of work and no payment, via:
      claim(bytes32 code) payable   // msg.value must be 0
- There are 42 codes (freeClaims() == 42). The contract stores keccak256(code) hashes pre-loaded by the owner via addCodes(bytes32[]); the raw code is never stored on-chain.
- Each code is single-use. Anyone holding an unclaimed code can redeem it; the token mints to the caller (msg.sender), so codes are secrets — do not post them.
- Seed for a claim: keccak256("claim", chainId, contract, msg.sender, code) (instead of a mined hash).
- Claimed tokens are flagged free (isFreeToken(tokenId) == true) and are non-transferable until wave >= 5 (wave = 1,000 paid mints); burning is allowed, marketplace transfer is blocked until then.
- Getters: freeClaims(), claimsLeft(), codesAvailable(), claimedCount(), isFreeToken(uint256). Event: Claimed(address indexed miner, uint256 indexed tokenId, bytes32 codeHash).
- Codes are activated by the project in the contract before distribution; until then codesAvailable() == 0 and a claim reverts with InvalidCode. Check codesAvailable() or the human page ${SITE_URL}/claim.

## 4. Pricing and supply

- freeClaims = 42: code-gated claims (no PoW, no payment; see "Free claims (codes)" above). Free-claim tokens are non-transferable until wave >= 5.
- Paid supply = 15,000 across 15 waves of epochSize 1,000.
- price = 1.0 * 2^epochIndex USDC, epochIndex = paidMinted / 1000, with no cap.
- Mint fee: +2.5% of the wave price (mintFeeBps = 250), collected to the treasury; currentMintDue() returns (due, fee).
- Schedule (wave / paid mints / price): wave 1 / 1-1000 / 1.0 USDC; wave 2 / 1001-2000 / 2.0; wave 3 / 2001-3000 / 4.0; wave 4 / 3001-4000 / 8.0; wave 5 / 4001-5000 / 16.0; ... wave 15 / 14001-15000 / 16,384 USDC (final wave, no cap).
- Funds accumulate in the contract; withdraw() is permissionless and sends the full balance to the immutable treasury (5% royalties also go to treasury).

## 5. Metadata and traits

GET ${SITE_URL}/api/meta/{id} returns OpenSea-compatible JSON, for example (shape as of the ARC-traits/2 set; live since 2026-09-21):

{
  "name": "Proof of Architect #1",
  "description": "Architector #1 — a deterministic NFT whose art and traits are generated on demand from the token's immutable on-chain seed.",
  "image": "${SITE_URL}/api/image/1",
  "external_url": "${SITE_URL}/token/1",
  "attributes": [
    { "trait_type": "background", "value": "Night" },
    { "trait_type": "head", "value": "Default" },
    { "trait_type": "outfit", "value": "Hoodie" },
    { "trait_type": "hair", "value": "Short" },
    { "trait_type": "hair_color", "value": "Ginger" },
    { "trait_type": "eyes", "value": "Default" },
    { "trait_type": "nose", "value": "Default" },
    { "trait_type": "mouth", "value": "Frown" },
    { "trait_type": "eyewear", "value": "Glasses" },
    { "trait_type": "headwear", "value": "Cap" },
    { "trait_type": "companion", "value": "None" },
    { "trait_type": "era", "value": "Genesis" },
    { "trait_type": "origin", "value": "Early Wanderer" },
    { "trait_type": "quote", "value": "None" },
    { "trait_type": "lore", "value": "None" }
  ]
}

The Architector has 15 slots (the ARC-traits/2 set, 69 trait values). Ten are rendered pixel-art layers, composited in this order: background, head, outfit, hair, eyes, nose, mouth, eyewear, headwear, companion. One is a render modifier (hair_color recolors the hair layer). Four are metadata-only text rows: era, origin, quote, lore.

Values are picked from the 32-byte seed by deterministic weighted rejection sampling. Each slot derives from keccak256(seed || uint8 slotIndex || uint16 counter), read as sixteen big-endian uint16 words, with the counter reset per slot. Same seed yields the same card, and anyone can recompute it from the on-chain seed. Head variants (ice / pale / reptile heads) adjust the nose and mouth layers per the render rules.

Rarity (OpenRarity-compatible): information content = sum over the token's traits of -log2(count(value) / totalTokens). Rarer tokens have higher information content.

## 6. HTTP API

Note: /api/meta, /api/mcp, /api/points, /api/agents and /stats/* are live (all open since 2026-09-21); /api/image serves a deterministic render for minted tokens (404 if the token is not minted).

- GET /api/meta/{id} — metadata JSON (reads seedOf/nonceOf/ownerOf on-chain, cached about 60 s). 404 if the token is not minted.
- GET /api/image/{id} — deterministic PNG Architector rendered from the seed (image/png). 1024x1024 by default; add ?master=1 for the 3072x3072 master. 404 if the token is not minted.
- GET /.well-known/ai.json — machine-readable service discovery (endpoints, contract, MCP tools).
- GET /openapi.yaml — OpenAPI 3.0 specification for the API.
- GET /sitemap.xml — pages plus one URL per minted token.

## Stats and agent docs

Machine-readable stats (SSR, no JS and no wallet gate):
- GET /stats — human page listing the live dataset; links to the JSON endpoints below.
- GET /stats/current.json — latest collection snapshot: wave, priceUsdc, totalMinted, maxSupply, freeClaims, claimsLeft, baseBits, currentRequiredBits, mintPaused, updatedAt, contract, chainId.
- GET /stats/history.jsonl — append-only newline-delimited JSON, one snapshot object per line.
- Changelog (RSS 2.0): ${SITE_URL}/changelog.xml — shipped milestones.
- Agent docs: /docs/agent-access (connect MCP + HTTP), /docs/verification (keccak-PoW math and verify_nonce), /docs/stats (dataset methodology).

## 7. MCP server

Streamable-HTTP MCP endpoint: ${SITE_URL}/api/mcp

Tools (all read-only):
- collection_stats — totalMinted, maxSupply (15,042), freeClaims, claimsLeft, currentWave, currentPrice (USDC), baseBits, paused.
- get_token (tokenId) — owner, seed, nonce, tokenURI, image and metadata URLs.
- required_bits (miner) — current difficulty for that wallet (three layers: wave base, load regulator, streak).
- verify_nonce (miner, nonce) — recomputes work locally and compares to the current target. Lets an agent verify a mined nonce WITHOUT sending a transaction.
- price_info — current wave (from currentWave()), current price (from currentPrice()), and the schedule: 1.0 USDC doubling every 1,000 paid mints across 15 waves, no cap.
- verify_rarity (tokenId) — recompute the token's OpenRarity information-content score and tier from its on-chain seed.
- craft_info — CraftingControllerV2 (ONE-SHOT) parameters: craftFee (fixed 5 USDC), per-tier boostCost/feeFor/maxChosen, craftNonce, bounds (MAX_SLOT, MAX_BOOST_TIER, LOCK_WAVES) and the child pre-seed formula (no commit/reveal/salt).

A standalone stdio MCP server with the same tools is published in the repository (mcp/).

## 8. How to mine (step by step)

1. Read requiredBits(yourAddress) — for example via the MCP tool required_bits or a contract read.
2. Grind nonces: work = keccak256(chainId, contract, yourAddress, nonce); accept when uint256(work) < targetFor(yourAddress). Expected attempts are 2^requiredBits.
3. Verify locally (the browser UI and MCP verify_nonce do this) before paying gas.
4. Submit mint(nonce) payable with msg.value == currentMintDue().due (wave price + 2.5% fee) and maxFeePerGas >= 20 gwei.
5. Repeat — difficulty rises within a wave by the streak, and by +2 bits per wave overall.

Tip: eth_estimateGas with a fresh random nonce reverts with BelowTarget(uint256 work, uint256 target), revealing your current difficulty for free without a transaction.

Performance reference: RTX 3090 about 2 GH/s, RTX 4090 about 4.8 GH/s (native CUDA), in-browser WebGPU miner orders of magnitude above a worker (hardware-dependent; hundreds of MH/s on desktop cards), browser Web Worker about 65 kH/s, pure Python about 0.17 MH/s. At baseBits 30 a plain worker is slow; a GPU (CUDA or in-browser WebGPU) is comfortable.

## 9. Crafting (HC/2, one-shot)

A holder can forge a new Architector (the child) from two Architectors they own (the parents), choosing which parent supplies each of the twelve choice-able slots. v3.4 crafting is a SINGLE transaction with no refusal: the two parents are escrowed and burned and the child is forged atomically. There is no commit, no reveal and no refund — crafted is taken. The child's pre-seed already exists on-chain, but the art seed adds a block hash that does not exist at craft time, so the result can be verified afterwards but never predicted or ground for before crafting.

- Controller: ${CRAFT_ADDRESS ?? "(not deployed yet — set NEXT_PUBLIC_CRAFT_ADDRESS)"} (CraftingControllerV2). Parents are the PARC NFT contract in section 2. The controller address is read from the build env and updates with the env swap.
- Child pre-seed: childSeed = keccak256(abi.encodePacked("PoA_CRAFT_v2", seedLow, seedHigh, minId, maxId, uint8 door, uint8 boostTier, uint64 nonce, keccak256(abi.encode(choices)))), where seedLow/seedHigh are the parents' RAW seedOf canonicalized by tokenId (minId/maxId), door is 0 (CRAFT_2_1) and choices is the SlotChoice[] array. The child's ART seed is then keccak256(childSeed ‖ blockhash(childMintBlock + 2)).
- Event: Crafted(uint256 indexed childId, address indexed player, uint256 cardA, uint256 cardB, bytes32 childSeed, uint8 boostTier, uint256 fee). The choices are NOT in the event (they are recoverable only from the craft transaction calldata).

Steps:

1. Approve the controller for both parents: call setApprovalForAll(controller, true) on the core NFT (one tx covers all future crafts). The controller pulls both parents with transferFrom, so a missing approval (or a non-transferable free token) reverts.
2. Choose a boost tier (0..3) and the inherited slots. Selectable slots are 0..11, strictly increasing, parent in {0,1}, at most maxChosen(tier) entries. Slot 12 (legendary) is always entropy-derived and cannot be chosen.
3. Send craft(cardA, cardB, choices, boostTier) payable with msg.value equal to feeFor(boostTier) exactly. Both parents are burned and the child is forged in the same transaction.
4. The child art is only final once blockhash(childMintBlock + 2) exists (~2 blocks). Until then the display seed is not final and the art/traits should be treated as pending.

Fee and parameters:

- fee = craftFee + boostCost. craftFee = 5.0 USDC (fixed on all waves); boostCost = 0 for tier 0, else 0.5 x currentPrice() x 2^(tier-1). All values are 18-decimal USDC and integer math; msg.value must match exactly.
- Boost tiers are 0..3; maxChosen = min(6 + 2 x tier, 12): tier 0 -> 6 slots, tier 1 -> 8, tier 2 -> 10, tier 3 -> 12.
- Free-claim tokens cannot be crafted before wave 5 (mirror of the core transfer lock).
- Reads: paused(), craftFee(), boostCost(tier), feeFor(tier), maxChosen(tier), totalFeesCollected(), craftNonce(), nft(), registry(), points().

## 10. Staking

Architectors can be locked in the StakingVault for a proof-of-work difficulty discount and a share of staking rewards. Staking is a HARD LOCK: choosing a term commits the card to the vault until that term ends — there is no early withdrawal.

- Vault: ${VAULT_ADDRESS ?? "(not deployed yet — set NEXT_PUBLIC_VAULT_ADDRESS)"} (StakingVault). The core NFT is the PARC contract in section 2. The vault address is read from the build env and updates with the env swap.
- Approve the vault for the token, then stake(tokenId, tier) (write). The vault holds the card until stakedAt + lockDays(tier)*86400; unstake(tokenId) (write) reverts Locked(uint64 until) before that timestamp. There is no early exit and no emergencyUnstake — a staked card cannot be withdrawn early by anyone.
- Tiers 0..5 (tier / lock / pool weight / PoW-discount bits): 0 flexible 0 days 0.1x 2 bits; 1 seven days 0.5x 2 bits; 2 thirty days 1.0x 4 bits; 3 ninety days 2.0x 4 bits; 4 one hundred eighty days 3.0x 6 bits; 5 three hundred sixty-five days 4.0x 6 bits. lockDays(tier) returns the exact term in days (0/7/30/90/180/365).
- Tier 0 (0 days) is flexible: lockEnd == stakedAt, so the card can be unstaked at any time. Every other tier is a hard lock until the term ends.
- While a card is staked it is out of circulation: the vault holds the NFT, so it cannot be transferred, sold or used as a craft parent until you unstake after the term ends.
- The PoW discount lowers your mining difficulty by the tier's bits (capped at 6); the pool weight sets your share of staking rewards.
- No early exit and no cooldown: an earlier design had an emergency exit and an address-bound re-stake cooldown (reStakeUnlockAt / InCooldown); both were removed. The only release is unstake() once the term has elapsed.
- Free-claim tokens (the first 42 ids) are non-transferable until wave 5 and cannot be staked before then.
- Reads: stakesOf(wallet), stakeInfo(tokenId), accruedOf(tokenId), weightOf(wallet), lockDays(tier). Events: Staked, Unstaked, PenaltyApplied, BoostSet.
- Agent tip: before staking, read lockDays(tier) to know the exact hard-lock length, and compute the lock end as stakeInfo(tokenId).stakedAt + lockDays(tier)*86400. Do not promise a user an early exit — there is none.

## 11. FAQ

- Is the randomness fair? There is no randomness. Arc's PREVRANDAO is always 0, so traits come from the PoW hash itself — anyone can re-verify a token's traits from its seed.
- What does a mint cost? 1.0 USDC at wave 1, doubling every wave of 1,000 paid mints with no cap (last wave 16,384 USDC). The 42 free claim codes need no payment and no PoW; redeem one at ${SITE_URL}/claim. Gas is paid in native USDC.
- How do I verify a nonce without sending a transaction? Use the MCP tool verify_nonce, or compare workFor(miner, nonce) on-chain with a local keccak computation.
- Where do the funds go? All proceeds and 5% secondary royalties go to the immutable treasury; withdraw() can be called by anyone but only pays the treasury.
- Is the contract audited? Yes — an independent audit is complete (H-01/H-02/M-01 fixed), the Foundry suite includes fuzz and invariant campaigns, and the live deployment is verified on the Arc explorer.

## 12. Status

The v3.4 "Proof of Architect" contracts are the current canon, live on Arc mainnet (${CANON_CORE}). The full stack — miners, metadata API, art pipeline, claim page (${SITE_URL}/claim), crafting and staking — is open.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
