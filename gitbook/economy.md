# Waves & Pricing

Proof of Architect has a fixed supply of **15,042** tokens. That supply is split into two parts:

- **42 free claim codes** — claimed with no mining and no payment.
- **15,000 paid mints** — the House's KEYSTONE — released across **15 waves** of 1,000 tokens each.

The base price is **1.0 USDC**, and it **doubles every wave**. There is no price cap. A **2.5% mint fee** is added on top of the wave price at mint time — the exact amount required is `currentMintDue()` (for example, wave 1: 1.025 USDC).

## Supply

| Component | Amount |
|---|---|
| Free claim codes | 42 |
| Paid mints (15 × 1,000) | 15,000 |
| **Total supply** | **15,042** |

Free claims are covered on [Claim Codes](claim-codes.md).

## The 15-wave price table

| Wave | Paid mints | Price per mint |
|---|---|---|
| 1 | 1 – 1,000 | 1 USDC |
| 2 | 1,001 – 2,000 | 2 USDC |
| 3 | 2,001 – 3,000 | 4 USDC |
| 4 | 3,001 – 4,000 | 8 USDC |
| 5 | 4,001 – 5,000 | 16 USDC |
| 6 | 5,001 – 6,000 | 32 USDC |
| 7 | 6,001 – 7,000 | 64 USDC |
| 8 | 7,001 – 8,000 | 128 USDC |
| 9 | 8,001 – 9,000 | 256 USDC |
| 10 | 9,001 – 10,000 | 512 USDC |
| 11 | 10,001 – 11,000 | 1,024 USDC |
| 12 | 11,001 – 12,000 | 2,048 USDC |
| 13 | 12,001 – 13,000 | 4,096 USDC |
| 14 | 13,001 – 14,000 | 8,192 USDC |
| 15 | 14,001 – 15,000 | 16,384 USDC |

## How the price is calculated

The base price is `1.0 USDC × 2^(wave − 1)`. A wave ends after 1,000 paid mints, and there is no cap on the later waves. You pay the base price of the wave you mint in plus the 2.5% mint fee.

Payment is made in **native USDC** (18 decimals), the gas token on Arc. See [Contracts](contracts.md) for the gas rules.

## Difficulty rises with the price

Each wave is also harder to mine: **+2 difficulty bits per wave**, on top of a base of **30 bits**. Wave 1 is 30 bits and wave 15 is 58 bits. Difficulty also moves within a wave because of the pace regulator and the per-wallet streak. See [Mining](mining.md) for the full model.

## Exact payment

The contract requires `msg.value` to equal `currentMintDue()` **exactly** — the wave price plus the 2.5% mint fee. Any other amount reverts. There is no partial payment and no refund — an incorrect amount simply fails the transaction, and only the gas is spent.

## Where the funds go

All proceeds, including the 2.5% mint fee, collect in the contract. Anyone can call `withdraw()`, but it can only send the full balance to the **immutable treasury** — the address is fixed at deployment and cannot be changed. The 5% secondary royalty (ERC-2981) also goes to that treasury.

## Architect's notes

Every wave pays for the next. The House keeps a ledger that writes itself: each wave's price is a line, each free claim a stamp. Above the treasury door the architect cut one word into the stone — CORNICE — and no one has ever needed to read it aloud.

## The kiln's heat

Burned cards are not gone for good: they can be reforged. A forged card is never minted into the paid range — the kiln keeps its own reserved county of token ids, set well above every minted token, so a re-fired card can never collide with a paid one. That reserved starting point is the House's heat constant.

## Where the revenue goes

Wave payments are split: **70%** flows to the staking pool as continuous USDC rewards for stakers, while **30%** is kept by the House (creator earnings). The **2.5% mint fee** and the **5% secondary royalty** go to the House in full. The **craft fee (fixed 5 USDC)** follows the same 70/30 split.

Everything collects in the immutable treasury first — its address is fixed at deployment and can never be changed. Every movement is visible on-chain.
