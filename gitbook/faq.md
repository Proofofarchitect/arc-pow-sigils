# Frequently Asked Questions

## Basics

**What is Proof of Architect?**
A proof-of-work minted NFT collection on **Arc**, Circle's EVM L1. Each token is a "House Card" produced by grinding a nonce; the winning hash becomes the token's on-chain seed, and the art derives from it.

**How do I get one?**
Two ways: claim one of the 42 free codes (no mining, no payment), or mine a nonce and mint a paid token. Paid pricing is on [Waves & Pricing](economy.md); the mining steps are in [Mining](mining.md).

**What does it cost?**
Paid mints start at **1.0 USDC** in wave 1 and double each wave, up to 16,384 USDC in wave 15, **plus a 2.5% mint fee** on top of the wave price. Free claim codes cost nothing. Gas is paid in native USDC.

## Mining

**How does proof-of-work mining work?**
You compute `keccak256(chainId, contract, yourAddress, nonce)` and keep changing the nonce until the hash starts with enough zero bits. That threshold is the difficulty, read on-chain per wallet. The hash you find becomes your token's seed.

**Why does difficulty change?**
Three layers: a base of 30 bits plus 2 bits per wave, a pace regulator that adjusts every 25 mints toward a 30-second-per-mint target, and a per-wallet streak that adds 2 bits for each extra mint inside a `60 s × wave` cooldown. The result is capped at 250 bits.

**Can I verify my nonce?**
Yes. You can recompute the hash locally, and the MCP `verify_nonce` tool does it for you without sending a transaction. See [For AI Agents](for-ai-agents.md).

## The art

**What is the House Card?**
Each token is a House Card built from 15 trait slots: ten rendered pixel layers, one rare golden overlay, and four metadata-only rows (era, origin, quote, lore).

**Are traits random?**
No. Traits are derived deterministically from the mined hash, so anyone can recompute them from the token's on-chain seed. There is no server randomness and no oracle.

**What is the golden trait?**
A rare overlay with two variants — **House Cat** and **Fat Rat**. It requires the card to have rolled the matching companion, and the variants are checked in a fixed order. See [Traits & Rarity](traits-and-rarity notes).

**In what order does the House read a card?**
A compass does not read the sky all at once; it walks it. The House reads a card the same way, and the walk has a fixed order — the garment comes first, then the age, then the glass set over the eyes, and the head itself last of all. Take the walk in that order and a card's layers fall into line.

## Free claims

**What is the free claim lock?**
Free tokens are non-transferable until **wave 5**. Until then they cannot be transferred or sold, at the contract level. After wave 5 they behave like any other token.

**What happens if my claim code leaks?**
Anyone holding an unclaimed code can claim it. Treat codes as secrets — see [Claim Codes](claim-codes.md).

## Payments and gas

**Why is gas paid in USDC?**
Arc uses native USDC (18 decimals) as its gas token instead of ETH. There is no separate gas token to acquire.

**What happens if I send the wrong payment?**
The transaction **reverts**. The contract requires `msg.value` to equal `currentMintDue()` exactly (the wave price plus the 2.5% mint fee).

**What if my fees are under 20 gwei?**
Arc silently drops transactions with `maxFeePerGas` below 20 gwei. Always set at least 20 gwei.

## Project

**Which wallets work?**
Any wallet that supports **Arc** and EVM transactions and can set a `maxFeePerGas` of at least 20 gwei.

**Is there a token?**
No. There is no utility token, and none is planned. The only assets are the NFTs.

**Is the collection live?**
Yes — mining, paid mints, free claims, crafting and staking are all live on Arc (chainId 5042002). See [Roadmap](roadmap.md).

**Is the contract audited?**
Yes. A full Foundry test suite (unit, fuzz and invariant campaigns) passes, an external audit is complete, and all medium-and-above findings are fixed. The contract is verified on the explorer. See [Contracts](contracts.md).
