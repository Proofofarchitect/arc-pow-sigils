import { SITE_URL } from "@/lib/site";

/**
 * /mine.md — markdown version of the mine page (llms.txt v2 convention).
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const body = `# Mining guide — Proof of Architect

> How to mine a nonce and mint a Proof of Architect Architector on Arc. Mining is pure keccak-256 work; the mint transaction then submits the nonce you found. You can also let an AI agent do the reads and verification via the MCP endpoint (${SITE_URL}/api/mcp).

## Before you start

- A wallet on Arc (chainId 5042002), funded with native USDC for gas (faucet: faucet.circle.com).
- No GPU is required to try, but base difficulty is 30 bits, which is heavy work: a GPU is strongly recommended. The browser worker (${SITE_URL}/mine) is fine for experimenting. Free claim codes (42) require no PoW at all.

## The algorithm

    work = keccak256(abi.encodePacked(uint256 chainId, address contract, address miner, uint256 nonce))
    valid  <=>  leadingZeroBits(work) >= requiredBits(miner)

requiredBits has three layers:
- wave base: baseBits 30 + 2 bits per wave (the price doubles every wave too).
- load regulator: adjusted every 25 mints toward a 30 s/mint pace target (dead zone plus or minus 20%, range 0..64 bits).
- per-wallet streak: +2 bits per extra mint from the same wallet while inside a cooldown window of 60 s x wave; the streak resets once the cooldown elapses.

- Duration scales with 2^bits. At 30 bits a GPU finds nonces in reasonable time; a browser worker is far slower.
- Nonces are single-use per wallet.

## Steps

1. Open ${SITE_URL}/mine and connect your wallet.
2. The page reads requiredBits(yourAddress) from the contract and starts the worker.
3. It verifies the found nonce locally (same formula as the contract) and submits mint(nonce).
4. Pay exactly currentMintDue().due in USDC (wave price plus the 2.5% mint fee): 1.0 USDC at wave 1, doubling every 1,000 paid mints with no cap. Free claim codes skip payment and PoW entirely.
5. Arc requires maxFeePerGas >= 20 gwei — transactions below that are silently dropped.

## Claiming a free code

Instead of mining, you can redeem one of the 42 free claim codes if you hold one: open ${SITE_URL}/claim, paste the code and confirm one wallet transaction. The contract call is claim(bytes32 code) with 0 value — no proof of work and no payment, only gas. Each code is single-use and the token mints to the caller, so treat codes as secrets. Claimed tokens are non-transferable until wave 5. Codes are activated by the project before distribution; if codesAvailable() is 0 the claim reverts with InvalidCode.

## Verification without a transaction

- Read workFor(miner, nonce) on-chain and compare with a local keccak computation, or
- Use the MCP tool verify_nonce on ${SITE_URL}/api/mcp: it recomputes the hash, counts leading zero bits and compares against the current target.

Tip: eth_estimateGas with a fresh random nonce reverts with BelowFloor(uint8 got, uint8 need) — a free difficulty read.

## Tuning

- Browser: keep one or two workers per machine.
- GPU: the repository ships a cupy-based CUDA miner (mining/gpu/gpu_mine.py). Reference rates: RTX 3090 about 2 GH/s, RTX 4090 about 4.8 GH/s.

## Related

- Crafting (HC/2) — forge one child card from two you own via commit/reveal with a secret salt — and staking (lock for a PoW bits discount) are documented in ${SITE_URL}/llms-full.txt and on ${SITE_URL}/craft and ${SITE_URL}/stake.

## FAQ

- Wrong payment? The contract requires msg.value to equal currentMintDue().due exactly (wave price plus the 2.5% mint fee).
- Nonce already used? Nonces are tracked per wallet; find a new one.
- Difficulty too high on a wallet? Difficulty rises within a wave by streak and resets after the cooldown; a fresh wallet starts at the wave base.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
