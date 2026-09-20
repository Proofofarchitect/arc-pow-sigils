#!/usr/bin/env node
/**
 * arc-pow-sigils-mcp — stdio MCP server for the "Proof of Architect" NFT collection.
 *
 * Read-only tools over the deployed PowMintNFTv3 contract on Arc testnet.
 * All tools return JSON encoded as a single text content block.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Address, Hex } from "viem";
import {
  CHAIN_ID,
  CONTRACT_ADDRESS,
  CRAFT_ADDRESS,
  SITE_URL,
  controllerAbi,
  encodeChoicesHash,
  formatUsdc,
  imageUrl,
  leadingZeroBits,
  metadataUrl,
  publicClient,
  powMintAbi,
  workFor,
  type SlotChoice,
} from "./chain.js";

/** Build a successful JSON text result. */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Condense an unexpected error into one short, leak-free line. Strips stack
 * frames and library version markers (e.g. "Version: viem@2.x.y") so raw
 * internals never reach the MCP client (external pentest finding F4).
 */
function shortErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? raw;
  msg = msg
    .replace(/version:\s*viem@\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/:+$/, "")
    .trim();
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

/**
 * Internal-error result: the client sees a short, stack-free reason; the full
 * error (with stack + versions) goes to stderr only.
 */
function failInternal(tool: string, err: unknown) {
  console.error(`[mcp] ${tool} error:`, err);
  return {
    content: [{ type: "text" as const, text: `Internal error: ${shortErr(err)}` }],
    isError: true,
  };
}

/**
 * Salt policy surfaced by `craft_info` (HC/2 spec §3 / W3-01 fix). Plain prose so
 * an agent can quote it verbatim; the controller cannot check salt entropy.
 */
const SALT_POLICY =
  "preimage = keccak256(abi.encode(SlotChoice[], bytes32 salt)); generate 32 random bytes per commit; keep secret until reveal; contract cannot verify salt entropy; salt=0 re-enables brute-force (≈94k choices for tier 0); lost salt ⇒ refund() only after commitBlock+258 (fee forfeited unless forgePaused)";

// Fallback on-chain config mirroring the v3 deploy defaults (used only if a read
// ever returns zero). Values are otherwise always read live from the contract.
const DEFAULTS = {
  epochSize: 1000n, // 15 paid waves × 1000
  priceStart: 1000000000000000000n, // 1 USDC
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const server = new McpServer({
  name: "arc-pow-sigils-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------- collection_stats
server.registerTool(
  "collection_stats",
  {
    title: "Collection stats",
    description:
      "Read live collection stats from PowMintNFTv3: totalMinted, maxSupply, " +
      "freeClaims, claimsLeft, claimedCount, currentWave, currentPrice (USDC " +
      "human units) and mintPaused.",
    inputSchema: {},
  },
  async () => {
    try {
      const [
        totalMinted,
        maxSupply,
        freeClaims,
        claimsLeft,
        claimedCount,
        currentWave,
        currentPrice,
        mintPaused,
      ] = await Promise.all([
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "totalMinted",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "maxSupply",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "freeClaims",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "claimsLeft",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "claimedCount",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "currentWave",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "currentPrice",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "mintPaused",
        }),
      ]);

      return ok({
        contract: CONTRACT_ADDRESS,
        chainId: CHAIN_ID,
        totalMinted: Number(totalMinted),
        maxSupply: Number(maxSupply),
        freeClaims: Number(freeClaims),
        claimsLeft: Number(claimsLeft),
        claimedCount: Number(claimedCount),
        currentWave: Number(currentWave),
        currentPrice: currentPrice.toString(),
        currentPriceUSDC: formatUsdc(currentPrice),
        mintPaused,
      });
    } catch (err) {
      return failInternal("collection_stats", err);
    }
  },
);

// ---------------------------------------------------------------- get_token
server.registerTool(
  "get_token",
  {
    title: "Get token",
    description:
      "Read a minted token: owner, seed, nonce, tokenURI, plus off-chain " +
      "image and metadata urls. Returns an error if the token does not exist.",
    inputSchema: {
      tokenId: z
        .number()
        .int()
        .positive()
        .describe("Token id (starts at 1 for the first mint)."),
    },
  },
  async ({ tokenId }) => {
    const id = BigInt(tokenId);
    try {
      const [owner, seed, nonce, tokenURI] = await Promise.all([
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "ownerOf",
          args: [id],
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "seedOf",
          args: [id],
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "nonceOf",
          args: [id],
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "tokenURI",
          args: [id],
        }),
      ]);

      return ok({
        tokenId,
        owner,
        seed,
        nonce: nonce.toString(),
        tokenURI,
        image: imageUrl(id),
        metadata: metadataUrl(id),
        siteUrl: SITE_URL,
      });
    } catch (err) {
      return failInternal("get_token", err);
    }
  },
);

// ---------------------------------------------------------------- required_bits
server.registerTool(
  "required_bits",
  {
    title: "Required bits",
    description:
      "Current PoW difficulty for a miner: requiredBits(miner) as leading zero " +
      "bits, plus its three layers (wave base, load regulator, active streak) " +
      "and the wallet's mint count.",
    inputSchema: {
      miner: z
        .string()
        .regex(ADDRESS_RE)
        .describe("EVM address of the miner (0x-prefixed, 20 bytes)."),
    },
  },
  async ({ miner }) => {
    try {
      const [bits, mints, baseBits, loadAdjust, streakBits, currentWave] =
        await Promise.all([
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: powMintAbi,
            functionName: "requiredBits",
            args: [miner as Address],
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: powMintAbi,
            functionName: "mintCount",
            args: [miner as Address],
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: powMintAbi,
            functionName: "baseBits",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: powMintAbi,
            functionName: "loadAdjust",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: powMintAbi,
            functionName: "streakBits",
            args: [miner as Address],
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: powMintAbi,
            functionName: "currentWave",
          }),
        ]);

      const wave = Number(currentWave);
      return ok({
        miner,
        bits: Number(bits),
        mintsByWallet: Number(mints),
        wave,
        epochIndex: wave - 1,
        baseBits: Number(baseBits),
        loadAdjust: Number(loadAdjust),
        streakBits: Number(streakBits),
        note:
          "Difficulty = baseBits + 2×epochIndex + loadAdjust + streakBits, capped at 250. " +
          "The streak term only applies while the wallet is inside its wave-scaled cooldown.",
      });
    } catch (err) {
      return failInternal("required_bits", err);
    }
  },
);

// ---------------------------------------------------------------- verify_nonce
server.registerTool(
  "verify_nonce",
  {
    title: "Verify nonce",
    description:
      "Verify a mined nonce WITHOUT sending a transaction: reads workFor(miner, " +
      "nonce), counts leading zero bits locally and compares to requiredBits(miner).",
    inputSchema: {
      miner: z
        .string()
        .regex(ADDRESS_RE)
        .describe("EVM address of the miner (0x-prefixed, 20 bytes)."),
      nonce: z
        .string()
        .regex(/^\d+$/)
        .describe("Nonce to check, uint256 as a decimal string."),
    },
  },
  async ({ miner, nonce }) => {
    try {
      const nonceBig = BigInt(nonce);
      const [workOnChain, required] = await Promise.all([
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "workFor",
          args: [miner as Address, nonceBig],
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "requiredBits",
          args: [miner as Address],
        }),
      ]);

      // Local recomputation (independent of the RPC round-trip).
      const workLocal = workFor(miner as Address, nonceBig);
      const bits = leadingZeroBits(workLocal);
      const need = Number(required);
      const matchesOnChain =
        workLocal.toLowerCase() === (workOnChain as string).toLowerCase();

      return ok({
        miner,
        nonce,
        work: workLocal,
        workMatchesOnChain: matchesOnChain,
        leadingZeroBits: bits,
        requiredBits: need,
        valid: bits >= need,
      });
    } catch (err) {
      return failInternal("verify_nonce", err);
    }
  },
);

// ---------------------------------------------------------------- price_info
server.registerTool(
  "price_info",
  {
    title: "Price info",
    description:
      "Explain the pricing: reads currentWave and currentPrice plus epoch config " +
      "(priceStart 1 USDC, x2 per wave, no cap) and returns a wave summary.",
    inputSchema: {},
  },
  async () => {
    try {
      const [
        totalMinted,
        maxSupply,
        freeClaims,
        currentWave,
        currentPrice,
        epochSize,
        priceStart,
      ] = await Promise.all([
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "totalMinted",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "maxSupply",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "freeClaims",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "currentWave",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "currentPrice",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "epochSize",
        }),
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: powMintAbi,
          functionName: "priceStart",
        }),
      ]);

      const es = epochSize > 0n ? epochSize : DEFAULTS.epochSize;
      const ps = priceStart > 0n ? priceStart : DEFAULTS.priceStart;

      const wave = Number(currentWave);
      // epochIndex() = paidMinted / epochSize; currentWave() = epochIndex() + 1.
      // The next price doubling lands when paidMinted reaches epochSize × wave.
      const nextWaveAtPaidMinted = es * BigInt(wave);
      const nextPrice = ps * (1n << BigInt(wave));

      return ok({
        contract: CONTRACT_ADDRESS,
        chainId: CHAIN_ID,
        wave,
        epochIndex: wave - 1,
        epochSize: Number(es),
        priceStartUSDC: formatUsdc(ps),
        currentPrice: currentPrice.toString(),
        currentPriceUSDC: formatUsdc(currentPrice),
        totalMinted: Number(totalMinted),
        maxSupply: Number(maxSupply),
        freeClaims: Number(freeClaims),
        priceCapUSDC: null, // no cap in v3
        nextWaveAtPaidMinted: Number(nextWaveAtPaidMinted),
        nextPriceUSDC: formatUsdc(nextPrice),
        note:
          "price = priceStart × 2^epochIndex (no cap), epochIndex = paidMinted / epochSize. " +
          "Free claims (no PoW) are separate from paid supply.",
      });
    } catch (err) {
      return failInternal("price_info", err);
    }
  },
);

// ---------------------------------------------------------------- craft_info
server.registerTool(
  "craft_info",
  {
    title: "Craft info",
    description:
      "Read-only view of the CraftingController v1 (commit-reveal House Card " +
      "crafting): paused, craftFee, per-tier boostCost/feeFor/maxChosen (0..3), " +
      "committedFees, lastCommitId and the reveal/entropy window constants " +
      "(ENTROPY_DELAY, MIN_REVEAL_DELAY, REVEAL_WINDOW). Also returns the salt " +
      "policy: preimage = keccak256(abi.encode(SlotChoice[], salt)).",
    inputSchema: {},
  },
  async () => {
    try {
      const tiers = [0, 1, 2, 3] as const;

      const [
        paused,
        craftFee,
        committedFees,
        lastCommitId,
        nft,
        entropyDelay,
        minRevealDelay,
        revealWindow,
      ] = await Promise.all([
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "paused",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "craftFee",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "committedFees",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "lastCommitId",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "nft",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "ENTROPY_DELAY",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "MIN_REVEAL_DELAY",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "REVEAL_WINDOW",
        }),
      ]);

      const tierRows = await Promise.all(
        tiers.map(async (tier) => {
          const [boostCost, feeFor, maxChosen] = await Promise.all([
            publicClient.readContract({
              address: CRAFT_ADDRESS,
              abi: controllerAbi,
              functionName: "boostCost",
              args: [tier],
            }),
            publicClient.readContract({
              address: CRAFT_ADDRESS,
              abi: controllerAbi,
              functionName: "feeFor",
              args: [tier],
            }),
            publicClient.readContract({
              address: CRAFT_ADDRESS,
              abi: controllerAbi,
              functionName: "maxChosen",
              args: [tier],
            }),
          ]);

          return {
            tier,
            boostCost: boostCost.toString(),
            boostCostUSDC: formatUsdc(boostCost),
            feeFor: feeFor.toString(),
            feeForUSDC: formatUsdc(feeFor),
            maxChosen: Number(maxChosen),
          };
        }),
      );

      return ok({
        controller: CRAFT_ADDRESS,
        chainId: CHAIN_ID,
        nft,
        paused,
        craftFee: craftFee.toString(),
        craftFeeUSDC: formatUsdc(craftFee),
        committedFees: committedFees.toString(),
        committedFeesUSDC: formatUsdc(committedFees),
        lastCommitId: lastCommitId.toString(),
        windows: {
          entropyDelay: Number(entropyDelay),
          minRevealDelay: Number(minRevealDelay),
          revealWindow: Number(revealWindow),
        },
        tiers: tierRows,
        saltPolicy: SALT_POLICY,
      });
    } catch (err) {
      return failInternal("craft_info", err);
    }
  },
);

// ------------------------------------------------------- verify_craft_commit
server.registerTool(
  "verify_craft_commit",
  {
    title: "Verify craft commit",
    description:
      "Verify a crafting commit WITHOUT sending a transaction: reads " +
      "commits(commitId) from the CraftingController, recomputes " +
      "keccak256(abi.encode(choices, salt)) the same way the contract does, and " +
      "reports whether it matches the on-chain choicesHash, plus settlement " +
      "flags, player, boost tier and the reveal window.",
    inputSchema: {
      commitId: z
        .number()
        .int()
        .positive()
        .describe("1-based commit id (see CraftingController.lastCommitId())."),
      choices: z
        .array(
          z.tuple([
            z.number().int().min(0).describe("slot 0..11"),
            z.number().int().min(0).describe("parent: 0 = cardA, 1 = cardB"),
          ]),
        )
        .describe(
          "Reveal choices as [slot, parent] pairs, in the exact order hashed at commit.",
        ),
      salt: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .describe("32-byte client secret (0x + 64 hex) used at commit."),
    },
  },
  async ({ commitId, choices, salt }) => {
    try {
      const [commit, head, minRevealDelay, revealWindow] = await Promise.all([
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "commits",
          args: [BigInt(commitId)],
        }),
        publicClient.getBlockNumber(),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "MIN_REVEAL_DELAY",
        }),
        publicClient.readContract({
          address: CRAFT_ADDRESS,
          abi: controllerAbi,
          functionName: "REVEAL_WINDOW",
        }),
      ]);

      const [
        player,
        cardA,
        cardB,
        choicesHashOnChain,
        boostTier,
        ,
        commitBlock,
        ,
        revealed,
        refunded,
      ] = commit;

      const slotChoices: SlotChoice[] = choices.map(([slot, parent]) => ({
        slot,
        parent,
      }));
      const computedHash = encodeChoicesHash(slotChoices, salt as Hex);
      const match =
        computedHash.toLowerCase() === choicesHashOnChain.toLowerCase();

      const revealFromBlock = commitBlock + minRevealDelay;
      const revealUntilBlock = commitBlock + revealWindow;
      const settled = revealed || refunded;
      const canRevealNow =
        !settled && head >= revealFromBlock && head <= revealUntilBlock;

      return ok({
        commitId,
        match,
        settled: { revealed, refunded },
        player,
        boostTier: Number(boostTier),
        window: {
          head: head.toString(),
          revealFromBlock: revealFromBlock.toString(),
          revealUntilBlock: revealUntilBlock.toString(),
          canRevealNow,
        },
        choicesHashOnChain,
        computedHash,
        note:
          "match compares the locally recomputed keccak256(abi.encode(choices, salt)) " +
          "with the on-chain choicesHash. canRevealNow is false once settled.",
      });
    } catch (err) {
      return failInternal("verify_craft_commit", err);
    }
  },
);

// ---------------------------------------------------------------- bootstrap
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for JSON-RPC frames.
  process.stderr.write(
    `arc-pow-sigils-mcp ready (chainId=${CHAIN_ID}, contract=${CONTRACT_ADDRESS})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
