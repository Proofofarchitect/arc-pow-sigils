# Contract & Verification

This page lists the official contract addresses and how to verify them yourself.

## Networks

| Network | chainId | Status |
|---|---|---|
| Arc | 5042002 | Live |

Arc uses native **USDC** (18 decimals) as its gas token, with sub-second blocks and instant finality. Transactions whose `maxFeePerGas` is below **20 gwei** are silently dropped — always set at least 20 gwei. See [Official Links & Safety](security.md).

## Contract

The current **v3.2** deployment is live and verified on arcscan:

    0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b

Explorer: `https://testnet.arcscan.app/address/0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b`

This is the **v3.2 REAL** deployment: an ERC-721 with symbol **PARC** and supply **15,042** (42 free claims + 15,000 paid). A **2.5% mint fee** (mintFeeBps 250) is added on top of the wave price at mint time — the exact amount required is `currentMintDue()`. It replaces an earlier v3.1 deployment that is no longer current.

## What the contract is

- **ERC-721** NFT with symbol **PARC** (v3.2).
- **ERC-2981** royalties at **5%** (500 bps), paid to the treasury.
- Total supply **15,042**: 42 free claims + 15,000 paid.
- The **treasury is immutable** and pinned at deployment. There is no `setTreasury()`.
- An **emergency pause** exists and can halt minting and claiming.

Guessing deployment addresses is never recommended. Legal-looking clones are common; verify before interacting. Always check the addressed contract's source on the explorer. Scammers may publish identical names and symbols. So the only safe source of truth is this page.

## Verification

The contract is verified on the explorer, so its source matches the bytecode. You can independently confirm the key parameters on-chain: `currentPrice()`, `currentMintDue()`, `currentWave()`, `requiredBits(wallet)`, `maxSupply()`, `freeClaims()`, and `treasury()`.

Never trust an address you did not verify yourself. A checked source on the explorer is the only authority. Verify before you interact — look-alikes are everywhere.

## How to check a mint

Every successful mint emits a `Mined` event carrying the miner, token id, nonce, hash, bits, and the amount paid. You can recompute the hash from the event data and confirm the token's seed — see [For AI Agents](for-ai-agents.md).
