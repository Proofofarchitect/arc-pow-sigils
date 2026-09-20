import { defineChain } from "viem";

/**
 * Arc chain definition.
 *
 * IMPORTANT: the native gas token is USDC with 18 decimals (NOT ETH, NOT 6).
 * Transaction fees are paid in USDC denominated at 18 decimals.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc",
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

/**
 * Resolve the RPC URL for the app. `NEXT_PUBLIC_ARC_RPC_URL` overrides the
 * public default so the same build can be re-pointed without a code change.
 */
export const ARC_RPC_URL: string =
  process.env.NEXT_PUBLIC_ARC_RPC_URL?.trim() ||
  arcTestnet.rpcUrls.default.http[0];

export const ARC_EXPLORER_URL: string = arcTestnet.blockExplorers.default.url;

/** Build an explorer link for a token id / address / tx hash. */
export function explorerUrl(path: string): string {
  return `${ARC_EXPLORER_URL.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
