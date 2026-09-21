import {
  createPublicClient,
  concatHex,
  defineChain,
  encodePacked,
  fallback,
  keccak256,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * Arc Testnet chain definition.
 *
 * IMPORTANT: the native gas token is USDC with 18 decimals (NOT ETH, NOT 6).
 * Kept local to this package on purpose — do not import across packages.
 */
const ARC_CHAIN_ID_ENV = Number(process.env.ARC_CHAIN_ID?.trim() || 5042);
/**
 * RPC endpoints (comma-separated list, first = primary). Official alternates:
 * Blockdaemon / dRPC / QuickNode (see Arc docs). Failover via viem `fallback`.
 */
const ARC_RPC_URLS_ENV = (
  process.env.ARC_RPC_URL?.trim() || "https://rpc.mainnet.arc.io"
)
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url.length > 0);
const ARC_RPC_ENV = ARC_RPC_URLS_ENV[0] ?? "https://rpc.mainnet.arc.io";
const ARC_EXPLORER_ENV =
  process.env.ARC_EXPLORER_URL?.trim() || "https://explorer.arc.io";
const ARC_IS_TESTNET_ENV = (process.env.ARC_IS_TESTNET ?? "false") !== "false";

/**
 * Arc chain definition (env-driven: mainnet 5042 by default since 2026-09-21;
 * testnet via `ARC_CHAIN_ID=5042002` + `ARC_RPC_URL=https://rpc.testnet.arc.io`).
 *
 * IMPORTANT: the native gas token is USDC with 18 decimals (NOT ETH, NOT 6).
 * Kept local to this package on purpose — do not import across packages.
 */
export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID_ENV,
  name: "Arc",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ARC_RPC_URLS_ENV,
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: ARC_EXPLORER_ENV,
    },
  },
  testnet: ARC_IS_TESTNET_ENV,
});

/** Arc chain id (env-driven). */
export const CHAIN_ID = ARC_CHAIN_ID_ENV;

/** USDC native decimals on Arc. */
export const USDC_DECIMALS = 18;

/** Deployed PowMintNFTv3_4 core (v3.4 canon, Arc mainnet) address; override with CONTRACT_ADDRESS. */
export const CONTRACT_ADDRESS: Address =
  (process.env.CONTRACT_ADDRESS?.trim() as Address | undefined) ||
  "0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4";

/** Primary RPC endpoint (list override via comma-separated ARC_RPC_URL). */
export const ARC_RPC_URL: string = ARC_RPC_ENV;

/**
 * Deployed CraftingControllerV2 (ONE-SHOT crafting, fixed 5 USDC fee) on Arc
 * testnet; override with CRAFT_ADDRESS.
 */
export const CRAFT_ADDRESS: Address =
  (process.env.CRAFT_ADDRESS?.trim() as Address | undefined) ||
  "0xb7f32811F19579D9FC6F0e5ac925473554091a91";

const rawSite = process.env.SITE_URL?.trim() || "https://proofofarchitect.builders";
/** Site base (no trailing slash) used to build off-chain image/metadata urls. */
export const SITE_URL = rawSite.replace(/\/$/, "");

/**
 * Minimal ABI surface used by the server. Signatures/types are taken verbatim
 * from contracts/src/PowMintNFTv3_4.sol (v3.4) — do not guess names or types.
 */
export const POW_MINT_NFT_ABI = [
  // --- economics / supply ---
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "freeClaims",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimsLeft",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimedCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // --- waves / price / difficulty config ---
  {
    type: "function",
    name: "epochSize",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "priceStart",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentWave",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "baseBits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "loadAdjust",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "mintPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  // --- per-miner views ---
  {
    type: "function",
    name: "requiredBits",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "requiredMilli",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "targetFor",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "stakingDiscountMilli",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "mintCount",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "streakBits",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // --- pow ---
  {
    type: "function",
    name: "workFor",
    stateMutability: "view",
    inputs: [
      { name: "miner", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  // --- token data ---
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "seedOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "nonceOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // v3.4: block the token was minted/forged in (0 for claim tokens).
    type: "function",
    name: "mintBlockOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

/** ABI parsed form for typed readContract calls. */
export const powMintAbi = parseAbi([
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function freeClaims() view returns (uint256)",
  "function claimsLeft() view returns (uint256)",
  "function claimedCount() view returns (uint256)",
  "function epochSize() view returns (uint256)",
  "function priceStart() view returns (uint256)",
  "function currentWave() view returns (uint256)",
  "function currentPrice() view returns (uint256)",
  "function baseBits() view returns (uint8)",
  "function loadAdjust() view returns (uint8)",
  "function mintPaused() view returns (bool)",
  "function requiredBits(address miner) view returns (uint8)",
  "function requiredMilli(address miner) view returns (uint256)",
  "function targetFor(address miner) view returns (uint256)",
  "function stakingDiscountMilli(address wallet) view returns (uint16)",
  "function mintCount(address) view returns (uint256)",
  "function streakBits(address) view returns (uint256)",
  "function workFor(address miner, uint256 nonce) view returns (bytes32)",
  "function ownerOf(uint256 id) view returns (address)",
  "function tokenURI(uint256 id) view returns (string)",
  "function seedOf(uint256 id) view returns (bytes32)",
  "function nonceOf(uint256 id) view returns (uint256)",
  "function mintBlockOf(uint256 id) view returns (uint64)",
]);

/** viem public client singleton (read-only, HTTP transport with endpoint failover). */
export const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: fallback(ARC_RPC_URLS_ENV.map((url) => http(url))),
});

/**
 * Minimal ABI surface for CraftingControllerV2 (ONE-SHOT crafting).
 * Signatures are taken verbatim from `contracts/src/CraftingControllerV2.sol`.
 */
export const controllerAbi = parseAbi([
  "function paused() view returns (bool)",
  "function craftFee() view returns (uint256)",
  "function boostCost(uint8 tier) view returns (uint256)",
  "function feeFor(uint8 tier) view returns (uint256)",
  "function maxChosen(uint8 tier) view returns (uint256)",
  "function totalFeesCollected() view returns (uint256)",
  "function craftNonce() view returns (uint64)",
  "function nft() view returns (address)",
  "function registry() view returns (address)",
  "function points() view returns (address)",
  "function DOOR_CRAFT_2_1() view returns (uint8)",
  "function MAX_SLOT() view returns (uint8)",
  "function MAX_BOOST_TIER() view returns (uint8)",
  "function LOCK_WAVES() view returns (uint256)",
  "function CRAFT_FEE() view returns (uint256)",
]);

/** One inherited slot: `parent` is 0 (cardA) or 1 (cardB); `slot` is 0..11. */
export type SlotChoice = { slot: number; parent: number };

/** Blocks between a mint and the block whose hash seeds its art (core SEED_DELAY_BLOCKS). */
export const SEED_DELAY_BLOCKS = 2n;

/** The block whose hash supplies post-inclusion display entropy. */
export function entropyBlockFor(mintBlock: bigint): bigint {
  return mintBlock + SEED_DELAY_BLOCKS;
}

/**
 * Post-inclusion display seed = keccak256(seedOf ‖ blockhash(mintBlock + 2)).
 * Claim tokens (mintBlock 0) keep the deterministic seed.
 */
export function deriveDisplaySeed(
  seedOf: Hex,
  mintBlock: bigint,
  entropyBlockHash: Hex,
): Hex {
  if (mintBlock === 0n) return seedOf;
  return keccak256(concatHex([seedOf, entropyBlockHash]));
}

export type DisplaySeed = {
  seedOf: Hex;
  mintBlock: bigint;
  displaySeed: Hex;
  pending: boolean;
};

/** Read seedOf + mintBlockOf and derive the display seed for a token. */
export async function readDisplaySeed(
  tokenId: bigint,
  client: PublicClient = publicClient,
): Promise<DisplaySeed> {
  const [seedOf, mintBlock] = await Promise.all([
    client.readContract({
      address: CONTRACT_ADDRESS,
      abi: powMintAbi,
      functionName: "seedOf",
      args: [tokenId],
    }),
    client.readContract({
      address: CONTRACT_ADDRESS,
      abi: powMintAbi,
      functionName: "mintBlockOf",
      args: [tokenId],
    }),
  ]);

  if (mintBlock === 0n) {
    return { seedOf, mintBlock, displaySeed: seedOf, pending: false };
  }

  const entropyBlock = entropyBlockFor(mintBlock);
  const head = await client.getBlockNumber();
  if (head < entropyBlock) {
    return { seedOf, mintBlock, displaySeed: seedOf, pending: true };
  }

  const block = await client.getBlock({ blockNumber: entropyBlock });
  if (!block.hash) {
    return { seedOf, mintBlock, displaySeed: seedOf, pending: true };
  }

  return {
    seedOf,
    mintBlock,
    displaySeed: deriveDisplaySeed(seedOf, mintBlock, block.hash),
    pending: false,
  };
}

/** v3.4 acceptance: valid iff uint256(work) < targetFor(miner). */
export function meetsTarget(work: Hex, target: bigint): boolean {
  return BigInt(work) < target;
}

/**
 * Count the leading zero bits of a 32-byte hash (bitstring order).
 * Matches PowMintNFTv3._leadingZeroBits: a keccak output is treated as a
 * 256-bit big-endian integer; returns 256 for an all-zero value.
 */
export function leadingZeroBits(hash: Hex): number {
  const hex = hash.startsWith("0x") ? hash.slice(2) : hash;
  const padded = hex.padStart(64, "0").slice(-64);
  const value = BigInt("0x" + padded);
  if (value === 0n) return 256;
  return 256 - value.toString(2).length;
}

/**
 * Reproduce the on-chain preimage hash:
 *   keccak256(abi.encodePacked(block.chainid, address(this), miner, nonce))
 * abi.encodePacked layout = 32 (uint256) ++ 20 (address) ++ 20 (address) ++ 32 (uint256).
 */
export function workFor(
  miner: Address,
  nonce: bigint,
  contract: Address = CONTRACT_ADDRESS,
  chainId: number = CHAIN_ID,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "address", "uint256"],
      [BigInt(chainId), contract, miner, nonce],
    ),
  );
}

/**
 * Format a native-USDC wei amount (18 decimals) into a human string.
 * Trims trailing zeros: 100000000000000000n -> "0.1".
 */
export function formatUsdc(wei: bigint): string {
  const s = formatUnits(wei, USDC_DECIMALS);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** {SITE_URL}/api/image/{id} — off-chain image endpoint. */
export function imageUrl(id: bigint | number): string {
  return `${SITE_URL}/api/image/${id.toString()}`;
}

/** {SITE_URL}/api/meta/{id} — off-chain metadata endpoint. */
export function metadataUrl(id: bigint | number): string {
  return `${SITE_URL}/api/meta/${id.toString()}`;
}
