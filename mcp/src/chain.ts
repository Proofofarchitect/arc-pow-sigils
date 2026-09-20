import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  encodePacked,
  formatUnits,
  http,
  keccak256,
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
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

/** Arc testnet chain id. */
export const CHAIN_ID = 5042002;

/** USDC native decimals on Arc. */
export const USDC_DECIMALS = 18;

/** Deployed PowMintNFTv3_1 (v3.2, testnet, migration 2026-09-19) address; override with CONTRACT_ADDRESS. */
export const CONTRACT_ADDRESS: Address =
  (process.env.CONTRACT_ADDRESS?.trim() as Address | undefined) ||
  "0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b";

/** RPC endpoint; override with ARC_RPC_URL. */
export const ARC_RPC_URL: string =
  process.env.ARC_RPC_URL?.trim() || arcTestnet.rpcUrls.default.http[0];

/**
 * Deployed CraftingController (Phase-2 stream C, commit-reveal crafting, fixed 5 USDC
 * fee — migration 2026-09-19) on Arc testnet; override with CRAFT_ADDRESS.
 */
export const CRAFT_ADDRESS: Address =
  (process.env.CRAFT_ADDRESS?.trim() as Address | undefined) ||
  "0x1542c820cF8644Abb91BF5c275097f89578FC3A9";

const rawSite = process.env.SITE_URL?.trim() || "https://proofofarchitect.builders";
/** Site base (no trailing slash) used to build off-chain image/metadata urls. */
export const SITE_URL = rawSite.replace(/\/$/, "");

/**
 * Minimal ABI surface used by the server. Signatures/types are taken verbatim
 * from contracts/src/PowMintNFTv3_1.sol (v3.1 keeps the v3 surface) — do not guess names or types.
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
  "function mintCount(address) view returns (uint256)",
  "function streakBits(address) view returns (uint256)",
  "function workFor(address miner, uint256 nonce) view returns (bytes32)",
  "function ownerOf(uint256 id) view returns (address)",
  "function tokenURI(uint256 id) view returns (string)",
  "function seedOf(uint256 id) view returns (bytes32)",
  "function nonceOf(uint256 id) view returns (uint256)",
]);

/** viem public client singleton (read-only, HTTP transport). */
export const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL),
});

/**
 * Minimal ABI surface for the CraftingController v1 (Phase-2 stream C).
 * Signatures are taken verbatim from `contracts/src/CraftingController.sol`.
 * `commits` is a public mapping of a struct, so its getter exposes the ten
 * fields in declaration order.
 */
export const controllerAbi = parseAbi([
  "function paused() view returns (bool)",
  "function craftFee() view returns (uint256)",
  "function boostCost(uint8 tier) view returns (uint256)",
  "function feeFor(uint8 tier) view returns (uint256)",
  "function maxChosen(uint8 tier) view returns (uint256)",
  "function committedFees() view returns (uint256)",
  "function lastCommitId() view returns (uint256)",
  "function ENTROPY_DELAY() view returns (uint256)",
  "function MIN_REVEAL_DELAY() view returns (uint256)",
  "function REVEAL_WINDOW() view returns (uint256)",
  "function nft() view returns (address)",
  "function commits(uint256) view returns (address player, uint256 cardA, uint256 cardB, bytes32 choicesHash, uint8 boostTier, uint64 nonce, uint64 commitBlock, uint256 fee, bool revealed, bool refunded)",
]);

/** One inherited slot: `parent` is 0 (cardA) or 1 (cardB); `slot` is 0..11. */
export type SlotChoice = { slot: number; parent: number };

/**
 * Reproduce the on-chain commit preimage (W3-01 fix):
 *   keccak256(abi.encode(SlotChoice[] choices, bytes32 salt))
 * Byte layout: head [offset to array = 0x40, salt (32)] ++ tail [length, then
 * each (slot, parent) tuple padded to 32 bytes]. Mirrors `lib/craft.ts`.
 */
export function encodeChoicesHash(choices: SlotChoice[], salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "slot", type: "uint8" },
            { name: "parent", type: "uint8" },
          ],
        },
        { type: "bytes32" },
      ],
      [choices, salt],
    ),
  );
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
