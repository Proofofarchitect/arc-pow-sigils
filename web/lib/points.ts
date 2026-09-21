import {
  createPublicClient,
  http,
  parseAbiItem,
  type AbiEvent,
} from "viem";
import { arcTestnet, ARC_RPC_URL } from "./arc";
import { rpcFetch } from "./rpc";
import { CONTRACT_ADDRESS } from "./contract";

/**
 * House Points — Season 1.
 *
 * Points are NOT stored anywhere: they are deterministically derived from the
 * public on-chain event stream of the core contract (Mined / Claimed / Forged /
 * Burned). Anyone — human or agent — can recompute the same numbers from the
 * same events, which keeps the program verifiable without a backend database.
 *
 * The Arc RPC caps eth_getLogs ranges (~10k blocks) and rate-limits the log
 * budget, so the scan is chunked, paced (2 workers) and checkpoint-cached
 * in-process: a warm process only scans blocks that arrived since the last
 * checkpoint. Block numbers are plain numbers (safe well beyond 2^53).
 *
 * Season 1 points are planned to convert into future PARC rewards at launch;
 * no guarantees are made and rules may change (see /points for the disclosure).
 */
export const POINT_RULES = {
  mine: 100,
  claim: 50,
  forge: 150,
  burn: 30,
} as const;

export type WalletPoints = {
  address: string;
  mined: number;
  claimed: number;
  forged: number;
  burned: number;
  points: number;
};

export type PointsSnapshot = {
  /** Block the snapshot was computed at (public, for reproducibility). */
  computedAtBlock: number;
  totals: {
    wallets: number;
    mined: number;
    claimed: number;
    forged: number;
    burned: number;
    points: number;
  };
  /** Sorted by points desc (ties: address asc). */
  wallets: WalletPoints[];
};

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 30_000, fetchFn: rpcFetch(6) }),
});

/**
 * First block of the current v3.4 contract stack (earliest v3.4 deploy tx,
 * 22030776). Override with POINTS_FROM_BLOCK if the core is redeployed.
 */
const FROM_BLOCK = Number(process.env.POINTS_FROM_BLOCK ?? "22030776");
// Arc testnet RPC: ~10k-block ranges are accepted (larger are rejected) and
// the log budget is roughly 2 requests/second — measured 2026-09-18.
const CHUNK_SIZE = 10_000;
const CONCURRENCY = 2;
const CHUNK_DELAY_MS = 1_000; // per worker, ≈2 req/s effective

type Field = keyof Omit<WalletPoints, "address" | "points">;

const EVENT_SPECS: { field: Field; addressArg: string; event: AbiEvent }[] = [
  {
    field: "mined",
    addressArg: "miner",
    event: parseAbiItem(
      "event Mined(address indexed miner, uint256 indexed tokenId, uint256 nonce, bytes32 work, uint8 bits, uint256 paid)",
    ),
  },
  {
    field: "claimed",
    addressArg: "miner",
    event: parseAbiItem(
      "event Claimed(address indexed miner, uint256 indexed tokenId, bytes32 codeHash)",
    ),
  },
  {
    field: "forged",
    addressArg: "to",
    event: parseAbiItem(
      "event Forged(address indexed to, uint256 indexed tokenId, bytes32 seed)",
    ),
  },
  {
    field: "burned",
    addressArg: "by",
    event: parseAbiItem(
      "event Burned(address indexed by, uint256 indexed tokenId)",
    ),
  },
];

/** Decoded log shape returned by the multi-event getLogs call. */
type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
};

const EVENT_META: Record<string, { field: Field; addressArg: string }> =
  Object.fromEntries(
    EVENT_SPECS.map((s) => [
      s.event.name,
      { field: s.field, addressArg: s.addressArg },
    ]),
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(
  from: number,
  to: number,
  attempt = 0,
): Promise<DecodedLog[]> {
  try {
    const logs = await client.getLogs({
      address: CONTRACT_ADDRESS,
      events: EVENT_SPECS.map((s) => s.event),
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    return logs as unknown as DecodedLog[];
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (attempt < 4 && /rate limit/i.test(message)) {
      await sleep(1_500 * 2 ** attempt);
      return fetchChunk(from, to, attempt + 1);
    }
    if (/range too large/i.test(message) && to > from) {
      // RPC lowered its range cap — split and recurse.
      const mid = Math.floor((from + to) / 2);
      const [a, b] = await Promise.all([
        fetchChunk(from, mid, attempt + 1),
        fetchChunk(mid + 1, to, attempt + 1),
      ]);
      return [...a, ...b];
    }
    throw e;
  }
}

async function scanRange(fromBlock: number, toBlock: number): Promise<DecodedLog[]> {
  const chunks: [number, number][] = [];
  for (let f = fromBlock; f <= toBlock; f += CHUNK_SIZE) {
    const t = Math.min(f + CHUNK_SIZE - 1, toBlock);
    chunks.push([f, t]);
  }
  const out: DecodedLog[] = [];
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const [f, t] = chunks[next++];
      const logs = await fetchChunk(f, t);
      out.push(...logs);
      await sleep(CHUNK_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return out;
}

/** In-process checkpoint cache: warm processes only scan new blocks. */
type Cache = { rows: Map<string, Row>; scannedTo: number };
type Row = { mined: number; claimed: number; forged: number; burned: number };
let cache: Cache | null = null;
/** Dedupe concurrent cold starts (e.g. /api/points + /api/agents) into one scan. */
let inflight: Promise<PointsSnapshot> | null = null;

function mergeLogs(rows: Map<string, Row>, logs: DecodedLog[]) {
  for (const log of logs) {
    const meta = EVENT_META[log.eventName];
    if (!meta) continue;
    const raw = log.args[meta.addressArg];
    if (typeof raw !== "string") continue;
    const key = raw.toLowerCase();
    let row = rows.get(key);
    if (!row) {
      row = { mined: 0, claimed: 0, forged: 0, burned: 0 };
      rows.set(key, row);
    }
    row[meta.field] += 1;
  }
}

export function fetchAllPoints(): Promise<PointsSnapshot> {
  if (!inflight) {
    inflight = computeAllPoints().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function computeAllPoints(): Promise<PointsSnapshot> {
  const latest = Number(await client.getBlockNumber());

  if (!cache) {
    cache = { rows: new Map(), scannedTo: FROM_BLOCK - 1 };
  }
  if (cache.scannedTo < latest) {
    const from = Math.max(FROM_BLOCK, cache.scannedTo + 1);
    if (from <= latest) {
      const logs = await scanRange(from, latest);
      mergeLogs(cache.rows, logs);
      cache.scannedTo = latest;
    }
  }

  const wallets: WalletPoints[] = [...cache.rows.entries()]
    .map(([address, r]) => ({
      address,
      ...r,
      points:
        r.mined * POINT_RULES.mine +
        r.claimed * POINT_RULES.claim +
        r.forged * POINT_RULES.forge +
        r.burned * POINT_RULES.burn,
    }))
    .filter((w) => w.points > 0)
    .sort((a, b) => b.points - a.points || a.address.localeCompare(b.address));

  const totals = wallets.reduce(
    (acc, w) => ({
      wallets: acc.wallets + 1,
      mined: acc.mined + w.mined,
      claimed: acc.claimed + w.claimed,
      forged: acc.forged + w.forged,
      burned: acc.burned + w.burned,
      points: acc.points + w.points,
    }),
    { wallets: 0, mined: 0, claimed: 0, forged: 0, burned: 0, points: 0 },
  );

  return { computedAtBlock: latest, totals, wallets };
}

export async function fetchPointsFor(address: string): Promise<WalletPoints> {
  const key = address.toLowerCase();
  const snapshot = await fetchAllPoints();
  return (
    snapshot.wallets.find((w) => w.address === key) ?? {
      address: key,
      mined: 0,
      claimed: 0,
      forged: 0,
      burned: 0,
      points: 0,
    }
  );
}
