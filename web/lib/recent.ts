import { CONTRACT_ADDRESS } from "./contract";

/**
 * Live activity feed — the most recent `Claimed` / `Mined` events of the core
 * contract, read from the Blockscout v2 API (the public Arc RPC does not serve
 * `eth_getLogs` over wide ranges, so the explorer index is the reliable source).
 *
 * Server-side only; the result is cached in-memory for ~20s so the client can
 * poll freely. On any failure the last cache (or an empty list) is returned —
 * the feed must never break the page.
 */

const EXPLORER_API =
  process.env.NEXT_PUBLIC_ARC_EXPLORER_API?.trim() ||
  "https://explorer.testnet.arc.io/api/v2";
const CACHE_MS = 20_000;
const FETCH_TIMEOUT_MS = 6_000;

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

type BlockscoutLogItem = {
  block_timestamp?: string;
  transaction_hash?: string;
  decoded?: {
    method_call?: string;
    parameters?: { name: string; value: string }[];
  };
};

function decodeItem(item: BlockscoutLogItem): RecentEvent | null {
  const method = item.decoded?.method_call ?? "";
  const params = Object.fromEntries(
    (item.decoded?.parameters ?? []).map((p) => [p.name, p.value]),
  );
  const base = {
    tokenId: Number(params.tokenId ?? 0),
    miner: params.miner ?? "",
    txHash: item.transaction_hash ?? "",
    timestamp: item.block_timestamp ?? "",
  };

  if (method.startsWith("Claimed")) {
    return { kind: "claim", codeHash: params.codeHash, ...base };
  }
  if (method.startsWith("Mined")) {
    return {
      kind: "mint",
      bits: params.bits !== undefined ? Number(params.bits) : undefined,
      paid: params.paid,
      ...base,
    };
  }
  return null;
}

let cache: { at: number; data: RecentEvent[] } | null = null;

export async function getRecentActivity(limit = 10): Promise<RecentEvent[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.data.slice(0, limit);
  }

  try {
    const response = await fetch(
      `${EXPLORER_API}/addresses/${CONTRACT_ADDRESS}/logs`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { items?: BlockscoutLogItem[] };
    const events = (json.items ?? [])
      .map(decodeItem)
      .filter((event): event is RecentEvent => event !== null)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    cache = { at: Date.now(), data: events };
    return events.slice(0, limit);
  } catch {
    // Serve the last known snapshot (or nothing) — never throw.
    return cache?.data.slice(0, limit) ?? [];
  }
}
