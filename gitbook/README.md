# Welcome

Proof of Architect is a proof-of-work NFT collection on **Arc**, Circle's EVM L1 where the native gas token is **USDC**. Instead of buying randomness, you mine it: you grind a nonce until its hash clears a difficulty target, and that winning hash becomes your token's permanent on-chain seed. The card's art and traits are a deterministic function of that seed, so anyone can recompute them.

If you only want to get a token, start with [How to Mint](how-to-mint.md). If you want to understand the mechanics first, read [Proof-of-Work Mining](mining.md).

## At a glance

| Item | Detail |
|---|---|
| Name | Proof of Architect |
| Symbol | **PARC** |
| Network | Arc — chainId 5042002 |
| Gas token | Native USDC, 18 decimals |
| Supply | 15,042 = 42 free claims + 15,000 paid |
| Waves | 15 waves of 1,000 paid mints |
| Price | 1.0 USDC × 2^(wave − 1) base + 2.5% mint fee, no cap |
| Royalty | 5% (ERC-2981) |
| Status | Live |

## Why proof of work

There is no server randomness and no oracle. A token's traits come from the keccak-256 hash you mined, so the card is fixed at mint and verifiable by anyone. You do not have to trust the project: you can recompute the hash and the traits yourself.

## The House Card

Each token is a pixel-art card built from **15 trait slots**: ten rendered layers, one rare golden overlay, and four metadata-only traits. Traits are selected from the mined seed, so the card is determined the moment it is minted. See [The Collection](the-collection.md).

## How mining works

You compute `keccak256(chainId ‖ contract ‖ miner ‖ nonce)` and change the nonce until the hash has enough leading zero bits. That threshold — the difficulty — rises by 2 bits each wave and also moves with a pace regulator and a per-wallet streak. See [Proof-of-Work Mining](mining.md) for the full model.

## Start here

- Understand the collection and the House Card art in [The Collection](the-collection.md).
- See how traits and rarity are derived in [Traits & Rarity](traits-and-rarity notes).
- Learn the mining model in [Proof-of-Work Mining](mining.md).
- Follow the steps to get a token in [How to Mint](how-to-mint.md).
- Check the waves and prices in [Waves & Pricing](economy.md).
- Read the contract details in [Contract & Verification](contracts.md).
- See the machine-readable surface for agents in [For AI Agents](for-ai-agents.md).

## Two ways to get a House Card

1. **Free claim code.** There are 42 one-time codes. Claiming needs no mining and no payment, and free tokens cannot be transferred until wave 5. See [Claim Codes](claim-codes.md).
2. **Paid mint.** Mine a valid nonce and pay exactly `currentMintDue()` — the current wave price plus the 2.5% mint fee — in native USDC. See [How to Mint](how-to-mint.md).

## Safety first

Before you mint, read [Official Links & Safety](security.md). Official links are the website **https://proofofarchitect.builders** and X **@proof_of_arc** (https://x.com/proof_of_arc); there is no official Discord yet. On Arc, any transaction with `maxFeePerGas` below **20 gwei** is silently dropped, so always set at least 20 gwei.

## No promises

House Cards are collectible assets. They carry no promise of profit, and nothing in these docs is investment advice. See [Legal](legal.md).

## Status and disclaimer

The **v3.2** contract is live and verified on arcscan (`0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b` — a 2.5% mint fee is added on top of the wave price at mint). Addresses and mechanics are **subject to change** without notice; always confirm details on the official website first.
