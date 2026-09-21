import { createPublicClient, http, parseAbiItem } from "viem";
import { arcChain, ARC_RPC_URL } from "./arc";
import { rpcFetch } from "./rpc";
import { CONTRACT_ADDRESS } from "./contract";

/**
 * Live activity feed — the most recent `Claimed` / `Mined` events of the core
 * contract, read straight from the Arc RPC via `eth_getLogs`.
 *
 * Why not the Blockscout explorer API: `explorer.arc.io/api/v2` sits behind a
 * Cloudflare challenge and rejects server-side fetches (403), so the feed went
 * empty on mainnet (RECENT-50-01, 2026-09-21). The RPC serves `getLogs` fine
 * over a rolling window, which is all a "latest events" feed needs.
 *
 * Server-side only; cached in-memory ~20s so the client can poll freely.
 * On any failure the last cache (or an empty list) is returned — the feed
 * must never break the page.
 */

const WINDOW_BLOCKS = 6_000n; // rolling window ≈ a few hours of Arc blocks
const CACHE_MS = 20_000;

export type RecentEvent = {
  kind: "claim" | "mint";
  tokenId: number;
  miner: string;
  /** Claimed: the code hash. */
  codeHash?: string;
  /** Mined: leading zero bits of the winning work hash. */
  bits?: number;
  /** Mined: USDC paid (18-dec string). */
  paid?: string;
  txHash: string;
  /** ISO timestamp of the block. */
  timestamp: string;
};

const MINED = parseAbiItem(
  "event Mined(address indexed miner, uint256 indexed tokenId, uint256 nonce, bytes32 work, uint8 bits, uint256 paid)",
);
const CLAIMED = parseAbiItem(
  "event Claimed(address indexed miner, uint256 indexed tokenId, bytes32 codeHash)",
);

const client = createPublicClient({
  chain: arcChain,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
});

let cache: { at: number; data: RecentEvent[] } | null = null;

type FeedItem = RecentEvent & { blockNumber: bigint; logIndex: number };

export async function getRecentActivity(limit = 10): Promise<RecentEvent[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.data.slice(0, limit);
  }

  try {
    const latest = await client.getBlockNumber();
    const from = latest > WINDOW_BLOCKS ? latest - WINDOW_BLOCKS : 0n;
    const address = CONTRACT_ADDRESS as `0x${string}`;

    const [mined, claimed] = await Promise.all([
      client.getLogs({ address, event: MINED, fromBlock: from, toBlock: latest }),
      client.getLogs({ address, event: CLAIMED, fromBlock: from, toBlock: latest }),
    ]);

    const items: FeedItem[] = [
      ...mined.map((log) => ({
        kind: "mint" as const,
        tokenId: Number(log.args.tokenId ?? 0n),
        miner: String(log.args.miner ?? ""),
        bits: log.args.bits !== undefined ? Number(log.args.bits) : undefined,
        paid: log.args.paid !== undefined ? String(log.args.paid) : undefined,
        txHash: log.transactionHash ?? "",
        timestamp: "",
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
      })),
      ...claimed.map((log) => ({
        kind: "claim" as const,
        tokenId: Number(log.args.tokenId ?? 0n),
        miner: String(log.args.miner ?? ""),
        codeHash: log.args.codeHash ? String(log.args.codeHash) : undefined,
        txHash: log.transactionHash ?? "",
        timestamp: "",
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
      })),
    ].sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? b.logIndex - a.logIndex
        : a.blockNumber < b.blockNumber
          ? 1
          : -1,
    );

    const uniqueBlocks = [...new Set(items.map((i) => Number(i.blockNumber)))];
    const timestamps = new Map<number, string>();
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        const block = await client.getBlock({ blockNumber: BigInt(bn) });
        timestamps.set(bn, new Date(Number(block.timestamp) * 1000).toISOString());
      }),
    );

    const events: RecentEvent[] = items.map((item) => ({
      kind: item.kind,
      tokenId: item.tokenId,
      miner: item.miner,
      codeHash: item.codeHash,
      bits: item.bits,
      paid: item.paid,
      txHash: item.txHash,
      timestamp: timestamps.get(Number(item.blockNumber)) ?? "",
    }));

    cache = { at: Date.now(), data: events };
    return events.slice(0, limit);
  } catch {
    return cache?.data.slice(0, limit) ?? [];
  }
}
