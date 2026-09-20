import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, ARC_RPC_URL } from "./arc";
import { rpcFetch } from "./rpc";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "./contract";

/**
 * Server-side on-chain reads for the metadata/image routes.
 *
 * Reads seedOf / nonceOf / ownerOf from the deployed PowMintNFT. These are the
 * same functions the canonical metadata spec consumes; only the ABI source
 * (lib/contract.ts) and the chain definition differ from the reference stub.
 */

const CACHE_TTL_MS = 60_000;

export type OnChainToken = {
  seed: Hex;
  nonce: bigint;
  owner: Address;
};

type CachedRead = {
  expiresAt: number;
  value: OnChainToken;
};

const globalCache = globalThis as typeof globalThis & {
  __arcNftMetadataCache?: Map<string, CachedRead>;
};

const cache =
  globalCache.__arcNftMetadataCache ??
  (globalCache.__arcNftMetadataCache = new Map<string, CachedRead>());

function getClient() {
  return {
    client: createPublicClient({
      chain: arcTestnet,
      transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch(6) }),
    }),
    contractAddress: getAddress(CONTRACT_ADDRESS),
  };
}

export function parseTokenId(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export async function getOnChainToken(tokenId: bigint): Promise<OnChainToken> {
  const cacheKey = tokenId.toString();
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { client, contractAddress } = getClient();

  const [seed, nonce, owner] = await Promise.all([
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "seedOf",
      args: [tokenId],
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "nonceOf",
      args: [tokenId],
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    }),
  ]);

  const value: OnChainToken = { seed, nonce, owner };

  cache.set(cacheKey, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return value;
}

export type CollectionStats = {
  totalMinted: bigint;
  maxSupply: bigint;
  freeClaims: bigint;
  claimsLeft: bigint;
  currentWave: bigint;
  currentPrice: bigint;
  mintPaused: boolean;
  baseBits: number;
};

type CachedStats = {
  expiresAt: number;
  value: CollectionStats;
};

const statsGlobal = globalThis as typeof globalThis & {
  __arcNftStatsCache?: CachedStats;
};

/**
 * Collection-wide reads (sitemap, MCP tools, health). Cached for 60s like the
 * per-token cache above.
 */
export async function getCollectionStats(): Promise<CollectionStats> {
  const cached = statsGlobal.__arcNftStatsCache;

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { client, contractAddress } = getClient();

  const [
    totalMinted,
    maxSupply,
    freeClaims,
    claimsLeft,
    currentWave,
    currentPrice,
    mintPaused,
    baseBits,
  ] = await Promise.all([
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "totalMinted",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "maxSupply",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "freeClaims",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "claimsLeft",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "currentWave",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "currentPrice",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "mintPaused",
    }),
    client.readContract({
      address: contractAddress,
      abi: POW_MINT_NFT_ABI,
      functionName: "baseBits",
    }),
  ]);

  const value: CollectionStats = {
    totalMinted,
    maxSupply,
    freeClaims,
    claimsLeft,
    currentWave,
    currentPrice,
    mintPaused,
    baseBits: Number(baseBits),
  };

  statsGlobal.__arcNftStatsCache = {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  return value;
}
