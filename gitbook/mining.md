# Proof-of-Work Mining

Mining is how every paid House Card is created. There is no purchase of randomness: you grind a nonce until its hash clears a difficulty target, and the winning hash becomes your token's seed.

## The work function

For a given miner address and nonce, the work is:

    work = keccak256(chainId ‖ contract ‖ miner ‖ nonce)

That preimage is 104 bytes: the chain id, the contract address, your address, and your nonce. A nonce is **valid** when the hash has at least `requiredBits` leading zero bits:

    leadingZeroBits(work) >= requiredBits(miner)

Each nonce is single-use per wallet: once it has minted, the same wallet cannot reuse it.

A nonce is good for one mint only. So a wallet must grind a new one for every paid token. Hash by hash, the target does not move for anyone.

## Difficulty in three layers

The target is not fixed. It is the sum of three parts, capped at **250 bits**:

| Layer | Effect |
|---|---|
| Wave base | 30 bits base plus 2 bits per wave |
| Pace regulator | Adjusts the load by 1 bit every 25 mints to hold a pace target |
| Per-wallet streak | Adds 2 bits per extra paid mint inside the cooldown window |

**Wave base.** The base is **30 bits** at wave 1, and each wave adds **2 bits** — roughly 4× harder per wave.

**Pace regulator.** Over a window of **25 mints**, the contract measures the average time per mint. If mints are faster than the target of about **30 seconds per mint**, it tightens by 1 bit; if slower, it loosens by 1 bit. There is a **±20% dead zone** around the target, and the regulator offset stays in the **0–64 bit** range.

**Per-wallet streak.** Inside a cooldown window of `60 seconds × wave`, each extra paid mint from the same wallet adds **2 bits** to that wallet's target. The streak resets once the window has elapsed without a mint, so rapid repeat minting from one wallet gets progressively harder.

## Compute

Expected attempts to find a valid nonce are about `2^requiredBits`, so difficulty grows exponentially with each added bit. Two miners are available:

- **Browser miner** — a Web Worker miner on the official website. Convenient and CPU-bound.
- **GPU miner** — a CUDA miner for power miners, published in the repository under `mining/gpu`.

<!-- CHECK: reference throughput numbers (approx. RTX 3090 ~2 GH/s, RTX 4090 ~4.8 GH/s, browser ~65 kH/s, Python ~0.17 MH/s) come from llms-full.txt; confirm before publishing -->

## Verifying a nonce

You can verify any nonce without trusting the project and without sending a transaction. Recompute the hash locally as above and compare the leading zero bits with `requiredBits`. The browser miner and the MCP `verify_nonce` tool do exactly this. See [For AI Agents](for-ai-agents.md).

A useful trick: calling `eth_estimateGas` with a fresh random nonce reverts with `BelowFloor(got, need)`, which reveals your current difficulty for free, without a transaction.

## How to start mining

1. Read `requiredBits(yourAddress)` for the current wave.
2. Grind nonces until one clears the target.
3. Verify the nonce locally.
4. Submit the mint with exactly `currentMintDue()` (wave price + 2.5% fee) and at least 20 gwei.

The full transaction steps are in [How to Mint](how-to-mint.md).

## Difficulty versus price

Mining and pricing are linked by the wave: as each wave sells out, the price doubles and the base difficulty rises by 2 bits. See [Waves & Pricing](economy.md) for the schedule.

Finding a nonce is a search, not a strategy. Luck is a tax everyone pays. In the end, persistence is the only edge that compounds. Nothing else moves the needle. The grind rewards whoever refuses to stop.

## Disclaimer

Difficulty parameters and the mining tools are **subject to change** without notice. Read the live values on-chain before mining — see [Contract & Verification](contracts.md).

<!-- CHECK: confirm the GPU miner location/command in mining/gpu and the browser miner entry point before publishing -->
