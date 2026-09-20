# How to Mint

This page walks through getting a paid House Card. Free claim codes are a separate path — see [Claim Codes](claim-codes.md).

Before you start, you need a wallet that supports **Arc** and can set a `maxFeePerGas` of at least **20 gwei**. Gas is paid in native **USDC** (18 decimals), not ETH.

## The wave price table

You pay the current wave base price plus a **2.5% mint fee**. The base price doubles each wave, with no cap.

| Wave | Paid mints | Price |
|---|---|---|
| 1 | 1 – 1,000 | 1 USDC |
| 2 | 1,001 – 2,000 | 2 USDC |
| 3 | 2,001 – 3,000 | 4 USDC |
| 4 | 3,001 – 4,000 | 8 USDC |
| 5 | 4,001 – 5,000 | 16 USDC |
| … | … | … |
| 15 | 14,001 – 15,000 | 16,384 USDC |

The full schedule is on [Waves & Pricing](economy.md).

## Step by step

1. **Set up your wallet.** Add Arc, fund it with enough native USDC to cover the current price plus the 2.5% mint fee and gas, and connect to the official website.
2. **Read your difficulty.** Before mining, read `requiredBits(yourAddress)`. The browser miner and the MCP `required_bits` tool show it. It depends on the wave, the pace regulator, and your streak.
3. **Mine a nonce.** Open the browser miner, or run the GPU miner for more power. The miner grinds nonces and accepts the first one that meets the target; that hash becomes your token's seed.
4. **Verify locally.** Recompute the hash and confirm the leading zero bits clear the target. The miner does this automatically, and you can also use `verify_nonce`.
5. **Submit the mint.** Send `mint(nonce)` with `msg.value` equal to `currentMintDue()` exactly (wave price + 2.5% fee) and `maxFeePerGas` of at least 20 gwei.
6. **Receive your House Card.** The contract stores the seed and issues the token. Its art and traits derive from that seed.

## Payment must be exact

The contract requires `msg.value` to equal `currentMintDue()` exactly — the wave price plus the 2.5% mint fee (`mintFeeBps` = 250). Any other amount reverts. An incorrect amount fails the transaction and only costs gas.

Payments here leave no room for rounding. Read the figure the core expects before you send anything. Even a single wei of difference is enough to turn the whole call away. Codes and mints share this discipline: the contract compares, it does not approximate. In the notes and in the chain the same rule is written. So the House keeps its books balanced, and expects the same of you. Every door here opens on an exact match or on nothing at all.

## The 20-gwei rule

Arc silently drops transactions whose `maxFeePerGas` is below **20 gwei**. If a mint seems to vanish, this is the usual reason. Always set at least 20 gwei.

## Free claim codes

If you hold one of the 42 free claim codes, you skip mining and payment entirely. A code is spent on first use, and free tokens cannot be transferred until **wave 5**. See [Claim Codes](claim-codes.md).

## After you mint

Your token is a standard **ERC-721** with **ERC-2981** royalties at **5%** to the treasury. You can view it through the metadata and image endpoints described in [The Collection](the-collection.md).

## Disclaimer

Addresses, prices, and mechanics are **subject to change** without notice. Always confirm the current price and contract address on-chain or on the official website: **https://proofofarchitect.builders**. See [Contract & Verification](contracts.md).

<!-- CHECK: confirm whether the browser miner and the claim flow live on the same page, and the exact mint function signature exposed in the UI, before publishing -->
