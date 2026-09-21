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
import { readDisplaySeed } from "./display-seed";

/**
 * Server-side on-chain reads for the metadata/image routes.
 *
 * Reads `seedOf` / `mintBlockOf` / `nonceOf` / `ownerOf` from the deployed
 * PowMintNFT v3.4. The DISPLAY seed (`displaySeed`) — the post-inclusion seed
 * that drives traits / rarity / art — is derived HERE (via `lib/display-seed.ts`)
 * so every consumer (/api/meta, /api/image, MCP) inherits one derivation.
 */

const CACHE_TTL_MS = 60_000;

export type OnChainToken = {
  /** Raw `seedOf[id]` — the work hash / claim hash / craft pre-seed. */
  seed: Hex;
  /** Post-inclusion display seed used for traits / rarity / art. */
  displaySeed: Hex;
  nonce: bigint;
  owner: Address;
  /** `mintBlockOf[id]` — 0 for claim tokens. */
  mintBlock: bigint;
  /** True while `mintBlockOf + 2` has not been mined yet (display seed not final). */
  pending: boolean;
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

  const [token, nonce, owner] = await Promise.all([
    readDisplaySeed(client, tokenId, contractAddress),
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

  const value: OnChainToken = {
    seed: token.seedOf,
    displaySeed: token.displaySeed,
    nonce,
    owner,
    mintBlock: token.mintBlock,
    pending: token.pending,
  };

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
