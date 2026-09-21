import type { Address } from "viem";
import { CANON_CORE } from "./canonical";

/**
 * Deployed PowMintNFTv3_4 core (v3.4 canon) on Arc testnet.
 * Default comes from the single source of truth (./canonical.ts).
 * Override with NEXT_PUBLIC_CONTRACT_ADDRESS if the contract is redeployed.
 */
export const CONTRACT_ADDRESS: Address =
  (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS?.trim() as Address | undefined) ||
  CANON_CORE;

/** Chain id of the configured Arc network (env-driven, see ./arc.ts). */
export { ARC_CHAIN_ID } from "./arc";

/**
 * Minimal ABI surface used by the frontend. Signatures/types are taken verbatim
 * from contracts/src/PowMintNFTv3_4.sol — do not guess names or types.
 */
export const POW_MINT_NFT_ABI = [
  // --- write ---
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: [],
  },
  {
    // v3.1 free claims: redeem a single-use code. Payable — but must send 0.
    type: "function",
    name: "claim",
    stateMutability: "payable",
    inputs: [{ name: "code", type: "bytes32" }],
    outputs: [],
  },
  // --- views ---
  {
    type: "function",
    name: "currentPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // v3.2: base wave price + mint fee (mintFeeBps, 250 = 2.5%). Mint requires msg.value == due.
    type: "function",
    name: "currentMintDue",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "due", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "currentWave",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // v3.4 display difficulty: ceil(requiredMilli/1000) leading zero bits.
    type: "function",
    name: "requiredBits",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    // v3.4 fractional difficulty in MILLI-BITS (thousandths of a bit).
    type: "function",
    name: "requiredMilli",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // v3.4 work target: valid iff uint256(workFor(miner,nonce)) < targetFor(miner).
    type: "function",
    name: "targetFor",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
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
    // v3.4: PoW-boost set by the StakingVault module, in MILLI-BITS (uint16).
    // 0..MAX_DISCOUNT_MILLI (6000 = 6 bits); can be fractional (500 = 0.5 bit).
    type: "function",
    name: "stakingDiscountMilli",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint16" }],
  },
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
    // Number of registered codes that are still claimable.
    type: "function",
    name: "codesAvailable",
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
  {
    // Claim-code lifecycle: 0 = unknown, 1 = registered & unspent, 2 = spent.
    // Key = keccak256(bytes32(code)) — same value as the CodeAdded event hash.
    type: "function",
    name: "codeStatus",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mintPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
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
    // v3.4: block the token was minted/forged in (0 for claim tokens). Feeds
    // the post-inclusion display seed (see lib/display-seed.ts).
    type: "function",
    name: "mintBlockOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  // --- events ---
  {
    type: "event",
    name: "Mined",
    inputs: [
      { name: "miner", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "work", type: "bytes32", indexed: false },
      { name: "bits", type: "uint8", indexed: false },
      { name: "paid", type: "uint256", indexed: false },
    ],
  },
  {
    // v3.1 free claims: emitted by `claim`; tokenId is the new token, codeHash
    // is keccak256(code) — the raw code never appears on-chain.
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "miner", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "codeHash", type: "bytes32", indexed: false },
    ],
  },
  {
    // v3.1 crafting: emitted by `burn` (CraftingController reveal, Burned×2).
    type: "event",
    name: "Burned",
    inputs: [
      { name: "by", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  {
    // v3.1 crafting: emitted by `forgeMint`; carries the new child tokenId and
    // its seed (used by /craft to parse the reveal receipt and preview HC/2).
    type: "event",
    name: "Forged",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "seed", type: "bytes32", indexed: false },
    ],
  },
] as const;
