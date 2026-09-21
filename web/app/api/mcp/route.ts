import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
} from "viem";
import { arcTestnet, ARC_RPC_URL } from "@/lib/arc";
import { rpcFetch } from "@/lib/rpc";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "@/lib/contract";
import { getCollectionStats, getOnChainToken } from "@/lib/chain";
import { CRAFT_ADDRESS, CONTROLLER_ABI } from "@/lib/craft";
import { formatUsdc } from "@/lib/format";
import { computeWork } from "@/lib/pow";
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

type Difficulty = { bits: number; milli: bigint; target: bigint };

/**
 * v3.4 difficulty for a miner: leading-zero bits (display), milli-bits and the
 * exact work target (`work < target`).
 */
async function readDifficulty(miner: Address): Promise<Difficulty> {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
  });

  const [bits, milli, target] = await Promise.all([
    client.readContract({
      address: CONTRACT_ADDRESS,
      abi: POW_MINT_NFT_ABI,
      functionName: "requiredBits",
      args: [miner],
    }),
    client.readContract({
      address: CONTRACT_ADDRESS,
      abi: POW_MINT_NFT_ABI,
      functionName: "requiredMilli",
      args: [miner],
    }),
    client.readContract({
      address: CONTRACT_ADDRESS,
      abi: POW_MINT_NFT_ABI,
      functionName: "targetFor",
      args: [miner],
    }),
  ]);

  return { bits: Number(bits), milli, target };
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
            chainId: ARC_CHAIN_ID,
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
          "Details of a minted Proof of Architect token: owner, raw on-chain seed (the winning PoW work hash, claim hash, or craft pre-seed), the DISPLAY seed (post-inclusion seed that drives traits/art), nonce, tokenURI, image and metadata URLs.",
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
            seedOf: token.seed,
            displaySeed: token.displaySeed,
            mintBlock: token.mintBlock.toString(),
            pending: token.pending,
            nonce: token.nonce.toString(),
            tokenURI: `${SITE_URL}/api/meta/${tokenId}`,
            imageUrl: `${SITE_URL}/api/image/${tokenId}`,
            metadataUrl: `${SITE_URL}/api/meta/${tokenId}`,
            note: "Traits/art derive from displaySeed = keccak256(seedOf ‖ blockhash(mintBlock + 2)) for minted/forged tokens; claim tokens (mintBlock 0) keep seedOf. pending=true means the entropy block is not mined yet.",
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
          "Current proof-of-work difficulty (leading zero bits) for a wallet. Difficulty has three layers: a wave base (baseBits 30 + 2 bits per wave), a load regulator (pace target 25 s/mint over a 5-mint window, ±20% dead zone, 0..64 bits; +2 bits when fast, -1 bit when slow), and a per-wallet streak (+2 bits per extra mint while inside a flat 5–25 min streak-level cooldown, capped at 25; the streak resets once the cooldown passes).",
        inputSchema: z.object({
          miner: z.string().describe("0x-prefixed EVM address"),
        }),
      },
      async ({ miner }) => {
        const address = parseAddress(miner);
        if (!address) return fail(`Invalid EVM address: ${miner}`);

        try {
          const d = await readDifficulty(address);
          return json({
            miner: address,
            requiredBits: d.bits,
            requiredMilli: d.milli.toString(),
            target: d.target.toString(),
            formula:
              "requiredMilli = (baseBits(30) + 2*waveIndex + loadAdjust + activeStreakBits)*1000 - stakingDiscountMilli, floored at baseBits*1000 (capped at 250 bits). Valid iff uint256(work) < targetFor(miner).",
            note: "Difficulty is per wallet and per wave. Nonces are single-use. requiredBits is the display value (ceil of requiredMilli/1000).",
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
          "Verify a mined nonce WITHOUT sending a transaction: recomputes work = keccak256(chainId, contract, miner, nonce) and checks it against the wallet's current fractional work target (valid iff uint256(work) < targetFor(miner)).",
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
          const d = await readDifficulty(address);
          const valid = BigInt(work) < d.target;

          return json({
            miner: address,
            nonce,
            work,
            requiredBits: d.bits,
            requiredMilli: d.milli.toString(),
            target: d.target.toString(),
            valid,
            note: "valid is checked against the CURRENT fractional target; a nonce mined before a wave escalation or regulator tightening may no longer pass.",
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
      "craft_info",
      {
        title: "Craft info",
        description:
          "Read-only view of CraftingControllerV2 (ONE-SHOT crafting, no commit/reveal/refund): pause flag, craftFee (fixed 5 USDC), per-tier boostCost / feeFor / maxChosen (tiers 0..3), totalFeesCollected, craftNonce, bounds (MAX_SLOT 11, MAX_BOOST_TIER 3, LOCK_WAVES 5) and the child pre-seed formula. A craft is a single payable craft(cardA, cardB, choices, boostTier) that burns both cards and forges the child atomically; the child art is only final after the entropy block.",
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
            totalFeesCollected,
            craftNonce,
            nft,
            maxSlot,
            maxBoostTier,
            lockWaves,
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
              functionName: "totalFeesCollected",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "craftNonce",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "nft",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "MAX_SLOT",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "MAX_BOOST_TIER",
            }),
            client.readContract({
              address,
              abi: CONTROLLER_ABI,
              functionName: "LOCK_WAVES",
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
            chainId: ARC_CHAIN_ID,
            nft,
            paused,
            craftFee: craftFee.toString(),
            craftFeeUSDC: formatUsdc(craftFee),
            totalFeesCollected: totalFeesCollected.toString(),
            craftNonce: craftNonce.toString(),
            bounds: {
              maxSlot: Number(maxSlot),
              maxBoostTier: Number(maxBoostTier),
              lockWaves: Number(lockWaves),
            },
            tiers: tierRows,
            model:
              "one-shot: craft(cardA, cardB, SlotChoice[] choices, uint8 boostTier) payable; both cards burned + child forged atomically; no commit/reveal/refund. child pre-seed = keccak256('PoA_CRAFT_v2' ‖ seedLow ‖ seedHigh ‖ minId ‖ maxId ‖ door ‖ tier ‖ nonce ‖ keccak256(abi.encode(choices))); display seed adds blockhash(childMintBlock + 2).",
          });
        } catch (err) {
          return failInternal("craft_info", err);
        }
      }
    );
  },
  {
    serverInfo: { name: "proof-of-architect", version: "3.4.0" },
  }
);

export async function GET(request: Request): Promise<Response> {
  return guardMcpRequest(request, handler);
}

export async function POST(request: Request): Promise<Response> {
  return guardMcpRequest(request, handler);
}
