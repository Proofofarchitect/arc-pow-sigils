/**
 * WalletConnect (Reown) v2 EthereumProvider — lazy client-side singleton.
 *
 * The mine page accepts any EIP-1193 provider; this module produces the
 * WalletConnect-backed one (QR pairing for mobile wallets). It is imported
 * dynamically so the heavy SDK never enters the server bundle or the initial
 * client chunk.
 *
 * Requires NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID — free project id from
 * https://cloud.reown.com (formerly WalletConnect Cloud).
 */
import { ARC_RPC_URL, arcTestnet } from "./arc";
import type { Eip1193Provider } from "./ethereum";

/** True when a WalletConnect project id is configured for this build. */
export function walletConnectEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim());
}

let providerPromise: Promise<Eip1193Provider> | null = null;

/**
 * Initialize (once) and return the WalletConnect provider.
 *
 * The provider persists its session in localStorage (`wc@2:*`), so a reload
 * can restore the pairing without a new QR scan — callers may simply request
 * `eth_requestAccounts` again.
 */
export async function getWalletConnectProvider(): Promise<Eip1193Provider> {
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error(
      "WalletConnect is not configured (missing NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID).",
    );
  }

  if (!providerPromise) {
    providerPromise = (async () => {
      const { EthereumProvider } = await import(
        "@walletconnect/ethereum-provider"
      );

      const provider = await EthereumProvider.init({
        projectId,
        // Arc has its own chain id; rpcMap lets wallets that support custom
        // EVM networks switch/add it during pairing.
        chains: [arcTestnet.id],
        optionalChains: [arcTestnet.id],
        showQrModal: true,
        rpcMap: { [arcTestnet.id]: ARC_RPC_URL },
        metadata: {
          name: "Proof of Architect",
          description:
            "PoW-minted Architectors on Arc — mine a nonce, mint an NFT, gas in USDC.",
          url:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://proofofarchitect.builders",
          icons: [],
        },
      });

      return provider as unknown as Eip1193Provider;
    })();

    // Allow a retry after a failed init (e.g. user closed the modal early).
    providerPromise.catch(() => {
      providerPromise = null;
    });
  }

  return providerPromise;
}

/** Best-effort disconnect of the WalletConnect session. */
export async function disconnectWalletConnect(): Promise<void> {
  if (!providerPromise) return;
  try {
    const provider = await providerPromise;
    const maybe = provider as unknown as { disconnect?: () => Promise<void> };
    await maybe.disconnect?.();
  } catch {
    // already disconnected / init failed — nothing to clean up
  } finally {
    providerPromise = null;
  }
}
