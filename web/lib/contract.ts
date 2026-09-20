import type { Address } from "viem";

/**
 * Deployed PowMintNFTv3_1 (v3.2, mainnet-config) address on Arc testnet.
 * Override with NEXT_PUBLIC_CONTRACT_ADDRESS if the contract is redeployed.
 */
export const CONTRACT_ADDRESS: Address =
  (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS?.trim() as Address | undefined) ||
  "0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b";

/** Chain id of Arc testnet. */
export const ARC_CHAIN_ID = 5042002;

/**
 * Minimal ABI surface used by the frontend. Signatures/types are taken verbatim
 * from contracts/src/PowMintNFTv3_1.sol (v3.1 keeps the v3 surface) — do not guess names or types.
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
    type: "function",
    name: "requiredBits",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "baseBits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    // v3.1 only: PoW-boost set by the StakingVault module (0..MAX_DISCOUNT_BITS).
    // On the v3 deployment this function does not exist — callers must tolerate
    // the revert (the /stake + /mine indicators fall back silently).
    type: "function",
    name: "stakingDiscountBits",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
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
