import {
  createPublicClient,
  getAddress,
  http,
  zeroAddress,
  type Address,
} from "viem";
import { arcTestnet, ARC_RPC_URL } from "./arc";
import { rpcFetch } from "./rpc";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "./contract";
import { getCollectionStats } from "./chain";
import { formatUsdc } from "./format";
import { SITE_URL } from "./site";

/**
 * Citable, machine-readable collection statistics (AI-discovery delta D1).
 *
 * Every number here is a direct read of the deployed contract — the same
 * `lib/chain.ts` viem publicClient the rest of the app uses. The snapshot is
 * serializable (no bigints) so it can be served verbatim as `/stats/current.json`
 * and rendered server-side (no client JS) on `/stats`.
 *
 * v3 vs v3.1 tolerance: fields that only exist on a v3.1 core (e.g.
 * `stakingDiscountBits`, and future burn/forge counters) are read through
 * `optionalRead` and OMITTED from the snapshot when the currently-configured
 * contract (v3) does not expose them — a missing read never fails the snapshot.
 */

/** Stable identifier for the snapshot schema; also used as the Dataset identifier. */
export const STATS_DOMAIN = "proofofarchitect.stats/1" as const;

export type StatsSnapshot = {
  domain: typeof STATS_DOMAIN;
  updatedAt: string;
  chainId: number;
  contract: Address;
  site: string;
  wave: number;
  priceUsdc: string;
  totalMinted: number;
  maxSupply: number;
  freeClaims: number;
  claimsLeft: number;
  mintPaused: boolean;
  baseBits: number;
  /** Baseline difficulty (bits) for a fresh wallet with no streak/stake bonus. */
  currentRequiredBits: number;
  /** v3.1-only: PoW-boost from the StakingVault module; omitted on v3. */
  stakingDiscountBits?: number;
};

function getClient() {
  return {
    client: createPublicClient({
      chain: arcTestnet,
      transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
    }),
    contractAddress: getAddress(CONTRACT_ADDRESS),
  };
}

/**
 * Run a read that may revert on the currently-configured contract version and
 * return `undefined` instead of throwing. Used for v3.1-only surface.
 */
async function optionalRead<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Read a snapshot of the live collection state.
 *
 * The core fields come from `getCollectionStats()` (60s-cached viem reads);
 * `requiredBits(zeroAddress)` is the baseline difficulty for a wallet with no
 * history. Extra v3.1-only reads are added when available, omitted otherwise.
 */
export async function getStatsSnapshot(): Promise<StatsSnapshot> {
  const { client, contractAddress } = getClient();

  const [stats, currentRequiredBits, stakingDiscountBits] = await Promise.all([
    getCollectionStats(),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "requiredBits",
      args: [zeroAddress],
    }),
    // v3.1-only: reverts on the v3 deployment -> omitted gracefully.
    optionalRead(() =>
      client.readContract({
        address: contractAddress,
        abi: POW_MINT_NFT_ABI,
        functionName: "stakingDiscountBits",
        args: [zeroAddress],
      }),
    ),
  ]);

  const snapshot: StatsSnapshot = {
    domain: STATS_DOMAIN,
    updatedAt: new Date().toISOString(),
    chainId: ARC_CHAIN_ID,
    contract: contractAddress,
    site: SITE_URL,
    wave: Number(stats.currentWave),
    priceUsdc: formatUsdc(stats.currentPrice),
    totalMinted: Number(stats.totalMinted),
    maxSupply: Number(stats.maxSupply),
    freeClaims: Number(stats.freeClaims),
    claimsLeft: Number(stats.claimsLeft),
    mintPaused: stats.mintPaused,
    baseBits: stats.baseBits,
    currentRequiredBits: Number(currentRequiredBits),
  };

  if (stakingDiscountBits !== undefined) {
    snapshot.stakingDiscountBits = Number(stakingDiscountBits);
  }

  return snapshot;
}
