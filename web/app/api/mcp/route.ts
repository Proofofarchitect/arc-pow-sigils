import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, ARC_RPC_URL } from "@/lib/arc";
import { rpcFetch } from "@/lib/rpc";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "@/lib/contract";
import { getCollectionStats, getOnChainToken } from "@/lib/chain";
import {
  CRAFT_ADDRESS,
  CONTROLLER_ABI,
  ENTROPY_DELAY,
  MIN_REVEAL_DELAY,
  REVEAL_WINDOW,
  encodeChoicesHash,
  type SlotChoice,
} from "@/lib/craft";
import { formatUsdc } from "@/lib/format";
import { computeWork, leadingZeroBits } from "@/lib/pow";
import { attributeMap, deriveAttributes } from "@/lib/traits";
import { deriveAttributesV2 } from "@/lib/traits_v2";
import { rarityForSeed } from "@/lib/rarity";
import { rarityForSeedV2 } from "@/lib/rarity_v2";
import { IS_V2 } from "@/lib/traits-set";
import { SITE_URL } from "@/lib/site";
import { guardMcpRequest } from "@/lib/mcp-guard";

/**
 * Remote MCP server (streamable HTTP) for the Proof of Architect collection.
 *
 * Exposes read-only tools so AI agents can answer questions about the
 * collection, verify mined nonces and explain pricing without writing code.
 * Mirrors the standalone stdio package in /mcp.
 *
 * Live economics are read from the chain via getCollectionStats(); the
 * constants below only document the v3 deployment parameters (Arc testnet,
 * chainId 5042002) so the schedule text matches the contract.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EPOCH_SIZE = 1000; // paid mints per wave
const PRICE_START_USDC = 1.0; // wave-1 price; doubles per wave, no cap
const FINAL_WAVE = 15; // 15,000 paid mints / 1,000 per wave
const EPOCH_BITS = 2; // +2 difficulty bits per wave
const BASE_BITS = 30; // wave-1 base difficulty (also reported by the chain)

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function parseAddress(value: string): Address | null {
  try {
    return getAddress(value.trim() as Address);
  } catch {
    return null;
  }
}

/**
 * Salt policy surfaced by `craft_info` (HC/2 spec §3 / W3-01 fix). Plain prose so
 * an agent can quote it verbatim; the controller cannot check salt entropy.
 */
const SALT_POLICY =
  "preimage = keccak256(abi.encode(SlotChoice[], bytes32 salt)); generate 32 random bytes per commit; keep secret until reveal; contract cannot verify salt entropy; salt=0 re-enables brute-force (≈94k choices for tier 0); lost salt ⇒ refund() only after commitBlock+258 (fee forfeited unless forgePaused)";

/**
 * Condense an unexpected error into one short, leak-free line. Strips stack
 * frames and library version markers (e.g. "Version: viem@2.x.y") so raw
 * internals never reach the MCP client (external pentest finding F4).
 */
function shortReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? raw;
  msg = msg
    .replace(/version:\s*viem@\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/:+$/, "")
    .trim();
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/**
 * Internal-error result: the client sees a short, stack-free reason; the full
 * error (with stack + versions) is written to the server log only.
 */
function failInternal(tool: string, err: unknown) {
  console.error(`[mcp] ${tool} error:`, err);
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: `Internal error: ${shortReason(err)}` },
    ],
  };
}

/** Read-only viem client for the CraftingController. */
function craftClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
  });
}

/** Map `[slot, parent]` pairs from the tool input to the controller's tuple. */
function toSlotChoices(choices: readonly [number, number][]): SlotChoice[] {
  return choices.map(([slot, parent]) => ({ slot, parent: parent as 0 | 1 }));
}

async function readRequiredBits(miner: Address): Promise<number> {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
  });

  return client.readContract({
    address: CONTRACT_ADDRESS,
    abi: POW_MINT_NFT_ABI,
    functionName: "requiredBits",
    args: [miner],
  });
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "collection_stats",
      {
        title: "Collection stats",
        description:
          "Current stats of the Proof of Architect NFT collection on Arc: total minted, max supply (15,042 = 42 free claims + 15,000 paid), free claims remaining, current wave, current mint price in USDC, paused flag, current base difficulty bits and contract address.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const s = await getCollectionStats();
          return json({
            collection: "Proof of Architect",
            site: SITE_URL,
            contract: CONTRACT_ADDRESS,
            chainId: 5042002,
            totalMinted: Number(s.totalMinted),
            maxSupply: Number(s.maxSupply),
            freeClaims: Number(s.freeClaims),
            claimsLeft: Number(s.claimsLeft),
            currentWave: Number(s.currentWave),
            currentPriceUSDC: formatUsdc(s.currentPrice),
            mintPaused: s.mintPaused,
            baseBits: s.baseBits,
          });
        } catch (err) {
          return failInternal("collection_stats", err);
        }
      }
    );

    server.registerTool(
      "get_token",
      {
        title: "Get token",
        description:
          "Details of a minted Proof of Architect token: owner, on-chain seed (the winning PoW work hash, or the claim hash for a free claim), nonce, tokenURI, image and metadata URLs. Art is a deterministic Architector derived from the seed.",
        inputSchema: z.object({
          tokenId: z.number().int().min(1).describe("1-based token id"),
        }),
      },
      async ({ tokenId }) => {
        try {
          const token = await getOnChainToken(BigInt(tokenId));
          return json({
            tokenId,
            owner: token.owner,
            seed: token.seed,
            nonce: token.nonce.toString(),
            tokenURI: `${SITE_URL}/api/meta/${tokenId}`,
            imageUrl: `${SITE_URL}/api/image/${tokenId}`,
            metadataUrl: `${SITE_URL}/api/meta/${tokenId}`,
          });
        } catch (err) {
          return failInternal("get_token", err);
        }
      }
    );

    server.registerTool(
      "required_bits",
      {
        title: "Required bits",
        description:
          "Current proof-of-work difficulty (leading zero bits) for a wallet. Difficulty has three layers: a wave base (baseBits 30 + 2 bits per wave), a load regulator (pace target 30 s/mint over a 25-mint window, ±20% dead zone, 0..64 bits), and a per-wallet streak (+2 bits per extra mint while inside a wave-scaled cooldown of 60 s × wave; the streak resets once the cooldown passes).",
        inputSchema: z.object({
          miner: z.string().describe("0x-prefixed EVM address"),
        }),
      },
      async ({ miner }) => {
        const address = parseAddress(miner);
        if (!address) return fail(`Invalid EVM address: ${miner}`);

        try {
          const bits = await readRequiredBits(address);
          return json({
            miner: address,
            requiredBits: bits,
            formula:
              "baseBits(30) + 2*waveIndex + loadAdjust + activeStreakBits (capped at 250)",
            note: "Difficulty is per wallet and per wave. Nonces are single-use.",
          });
        } catch (err) {
          return failInternal("required_bits", err);
        }
      }
    );

    server.registerTool(
      "verify_nonce",
      {
        title: "Verify nonce",
        description:
          "Verify a mined nonce WITHOUT sending a transaction: recomputes work = keccak256(chainId, contract, miner, nonce), counts leading zero bits and compares against the wallet's current required bits.",
        inputSchema: z.object({
          miner: z.string().describe("0x-prefixed EVM address of the miner"),
          nonce: z
            .string()
            .regex(/^\d+$/)
            .describe("Nonce as a decimal string (uint256)"),
        }),
      },
      async ({ miner, nonce }) => {
        const address = parseAddress(miner);
        if (!address) return fail(`Invalid EVM address: ${miner}`);

        try {
          const work = computeWork(address, BigInt(nonce));
          const bits = leadingZeroBits(work);
          const required = await readRequiredBits(address);

          return json({
            miner: address,
            nonce,
            work,
            leadingZeroBits: bits,
            requiredBits: required,
            valid: bits >= required,
            note: "valid is checked against the CURRENT difficulty; a nonce mined before a wave escalation or regulator tightening may no longer pass.",
          });
        } catch (err) {
          return failInternal("verify_nonce", err);
        }
      }
    );

    server.registerTool(
      "price_info",
      {
        title: "Price info",
        description:
          "Mint price now and the full schedule: 42 free claim codes, then 1.0 USDC at wave 1 doubling every 1,000 paid mints across 15 waves with no price cap (last wave 16,384 USDC). Wave is read from currentWave() and price from currentPrice().",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const s = await getCollectionStats();
          const wave = Number(s.currentWave); // 1-based, = epochIndex + 1
          const epochIndex = wave - 1; // 0-based

          return json({
            wave,
            epochIndex,
            currentPriceUSDC: formatUsdc(s.currentPrice),
            maxSupply: Number(s.maxSupply),
            totalMinted: Number(s.totalMinted),
            freeClaims: Number(s.freeClaims),
            claimsLeft: Number(s.claimsLeft),
            nextWave: wave < FINAL_WAVE ? wave + 1 : null,
            nextWaveAtPaidMints: wave * EPOCH_SIZE,
            schedule: {
              free: `${Number(s.freeClaims)} code-gated claims (no PoW, no payment)`,
              pricing: `${PRICE_START_USDC} USDC × 2^(wave−1), doubling every ${EPOCH_SIZE} paid mints, no cap`,
              difficultyPerWave: `+${EPOCH_BITS} bits (base ${BASE_BITS} at wave 1)`,
              waves: FINAL_WAVE,
              finalWavePriceUSDC: (
                PRICE_START_USDC *
                2 ** (FINAL_WAVE - 1)
              ).toFixed(0),
            },
          });
        } catch (err) {
          return failInternal("price_info", err);
        }
      }
    );

    server.registerTool(
      "verify_rarity",
      {
        title: "Verify rarity",
        description:
          "Rarity of a minted token, derived from its on-chain seed: the canonical rarity/1 information-content score in bits, its tier (Standard, Notable, Rare, Epic, Mythic), whether a golden event fired, and which legendary trait it rolled. Matches the `rarity` field served at /api/meta/{id}.",
        inputSchema: z.object({
          tokenId: z.number().int().min(1).describe("1-based token id"),
        }),
      },
      async ({ tokenId }) => {
        try {
          const token = await getOnChainToken(BigInt(tokenId));
          const { score, tier } = IS_V2
            ? rarityForSeedV2(token.seed)
            : rarityForSeed(token.seed);
          const derived = IS_V2
            ? deriveAttributesV2(token.seed)
            : deriveAttributes(token.seed);

          return json({
            tokenId,
            seed: token.seed,
            score: Number(score.toFixed(2)),
            tier,
            golden: derived.golden,
            legendary: IS_V2 ? "None" : attributeMap(derived).legendary,
          });
        } catch (err) {
          return failInternal("verify_rarity", err);
        }
      }
    );

    server.registerTool(
      "craft_info",
      {
        title: "Craft info",
        description:
          "Read-only view of the CraftingController v1 (commit-reveal Architector crafting) on Arc: pause flag, craftFee, per-tier boostCost / feeFor / maxChosen (tiers 0..3), committedFees, lastCommitId, and the reveal/entropy window constants (ENTROPY_DELAY, MIN_REVEAL_DELAY, REVEAL_WINDOW). Also returns the salt policy: the commit preimage is keccak256(abi.encode(SlotChoice[], salt)) and the salt is a 32-byte client secret the contract cannot verify.",
        inputSchema: z.object({}),
      },
      async () => {
        if (!CRAFT_ADDRESS) {
          return fail(
            "CraftingController is not configured for this deployment (NEXT_PUBLIC_CRAFT_ADDRESS is unset)."
          );
        }

        try {
          const client = craftClient();
          const address = CRAFT_ADDRESS;
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
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "paused",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "craftFee",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "committedFees",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "lastCommitId",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "nft",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "ENTROPY_DELAY",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "MIN_REVEAL_DELAY",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "REVEAL_WINDOW",
            }),
          ]);

          const tierRows = await Promise.all(
            tiers.map(async (tier) => {
              const [boostCost, feeFor, maxChosen] = await Promise.all([
                client.readContract({
                  address,
                  abi: CONTROLLER_ABI,
                  functionName: "boostCost",
                  args: [tier],
                }),
                client.readContract({
                  address,
                  abi: CONTROLLER_ABI,
                  functionName: "feeFor",
                  args: [tier],
                }),
                client.readContract({
                  address,
                  abi: CONTROLLER_ABI,
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
            })
          );

          return json({
            controller: address,
            chainId: 5042002,
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
      }
    );

    server.registerTool(
      "verify_craft_commit",
      {
        title: "Verify craft commit",
        description:
          "Verify a crafting commit WITHOUT sending a transaction: reads commits(commitId) from the CraftingController, recomputes keccak256(abi.encode(choices, salt)) the same way the contract does, and reports whether the computed hash matches the on-chain choicesHash. Also returns the settlement flags, the player and boost tier, and the reveal window (head block, revealFromBlock, revealUntilBlock, canRevealNow).",
        inputSchema: z.object({
          commitId: z
            .number()
            .int()
            .min(1)
            .describe("1-based commit id (see CraftingController.lastCommitId())"),
          choices: z
            .array(
              z.tuple([
                z.number().int().min(0).describe("slot 0..11"),
                z.number().int().min(0).describe("parent: 0 = cardA, 1 = cardB"),
              ])
            )
            .describe(
              "Reveal choices as [slot, parent] pairs, in the exact order hashed at commit"
            ),
          salt: z
            .string()
            .regex(/^0x[0-9a-fA-F]{64}$/)
            .describe("32-byte client secret (0x + 64 hex) used at commit"),
        }),
      },
      async ({ commitId, choices, salt }) => {
        if (!CRAFT_ADDRESS) {
          return fail(
            "CraftingController is not configured for this deployment (NEXT_PUBLIC_CRAFT_ADDRESS is unset)."
          );
        }

        try {
          const client = craftClient();
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
          ] = await client.readContract({
            address: CRAFT_ADDRESS,
            abi: CONTROLLER_ABI,
            functionName: "commits",
            args: [BigInt(commitId)],
          });

          const head = await client.getBlockNumber();
          const computedHash = encodeChoicesHash(
            toSlotChoices(choices),
            salt as Hex
          );
          const match =
            computedHash.toLowerCase() === choicesHashOnChain.toLowerCase();

          const revealFromBlock = commitBlock + MIN_REVEAL_DELAY;
          const revealUntilBlock = commitBlock + REVEAL_WINDOW;
          const settled = revealed || refunded;
          const canRevealNow =
            !settled && head >= revealFromBlock && head <= revealUntilBlock;

          return json({
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
            note: "match compares the locally recomputed keccak256(abi.encode(choices, salt)) with the on-chain choicesHash. canRevealNow is false once the commit is settled (revealed or refunded).",
          });
        } catch (err) {
          return failInternal("verify_craft_commit", err);
        }
      }
    );
  },
  {
    serverInfo: { name: "proof-of-architect", version: "3.0.0" },
  }
);

export async function GET(request: Request): Promise<Response> {
  return guardMcpRequest(request, handler);
}

export async function POST(request: Request): Promise<Response> {
  return guardMcpRequest(request, handler);
}
