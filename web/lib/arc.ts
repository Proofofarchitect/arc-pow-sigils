import { defineChain } from "viem";

/**
 * Arc chain definition — NETWORK-PARAMETERIZED.
 *
 * The same build can point at Arc **testnet** (chainId 5042002) or Arc
 * **mainnet** (chainId 5042) purely via env — no code change to go live.
 * Defaults = testnet, so existing deployments are unaffected.
 *
 *   NEXT_PUBLIC_ARC_CHAIN_ID      default 5042002   (mainnet: 5042)
 *   NEXT_PUBLIC_ARC_RPC_URL       default https://rpc.testnet.arc.io
 *                                 (comma-separated failover list; official
 *                                  alternates: Blockdaemon / dRPC / QuickNode —
 *                                  failover handled by `rpcFetch`, lib/rpc.ts)
 *   NEXT_PUBLIC_ARC_EXPLORER_URL  default https://testnet.arcscan.app
 *   NEXT_PUBLIC_ARC_IS_TESTNET    default "true"    (mainnet: "false")
 *
 * IMPORTANT: the native gas token is USDC with 18 decimals (NOT ETH, NOT 6),
 * on both testnet and mainnet.
 */

function envStr(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

/** Arc chain id (env-driven): 5042002 testnet · 5042 mainnet. */
export const ARC_CHAIN_ID: number = Number(
  envStr("NEXT_PUBLIC_ARC_CHAIN_ID", "5042002"),
);

/**
 * RPC endpoints (failover list, first = primary). `NEXT_PUBLIC_ARC_RPC_URL`
 * may contain a comma-separated list of endpoints; `rpcFetch()` (lib/rpc.ts)
 * fails over to the remaining entries when an endpoint keeps failing.
 * Official alternates: Blockdaemon / dRPC / QuickNode (see Arc docs).
 */
export const ARC_RPC_URLS: string[] = envStr(
  "NEXT_PUBLIC_ARC_RPC_URL",
  "https://rpc.testnet.arc.io",
)
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

/** Primary RPC URL (first of `ARC_RPC_URLS`) — back-compat alias. */
export const ARC_RPC_URL: string =
  ARC_RPC_URLS[0] ?? "https://rpc.testnet.arc.io";

export const ARC_EXPLORER_URL: string = envStr(
  "NEXT_PUBLIC_ARC_EXPLORER_URL",
  "https://testnet.arcscan.app",
);

const ARC_IS_TESTNET: boolean =
  envStr("NEXT_PUBLIC_ARC_IS_TESTNET", "true") !== "false";

export const arcChain = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ARC_RPC_URLS,
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: ARC_EXPLORER_URL,
    },
  },
  testnet: ARC_IS_TESTNET,
});

/** Back-compat alias (older imports used `arcTestnet`). */
export const arcTestnet = arcChain;

/** Build an explorer link for a token id / address / tx hash. */
export function explorerUrl(path: string): string {
  return `${ARC_EXPLORER_URL.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
