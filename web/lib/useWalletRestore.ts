"use client";

import { useEffect, useRef } from "react";
import type { Address } from "viem";
import type { Eip1193Provider } from "./ethereum";
import {
  getWalletConnectProvider,
  walletConnectEnabled,
} from "./walletconnect";

type WalletEvents = {
  onAccountsChanged?: (address: Address | null) => void;
  onChainChanged?: (chainId: number) => void;
  onDisconnect?: () => void;
};

/**
 * Silent reconnect for the tx pages: on mount, restore an already-authorized
 * wallet — injected (`eth_accounts`, never a popup) or a persisted
 * WalletConnect session (`wc@2:*` in localStorage). Without it every page
 * shows "Connect wallet" until the user clicks, even while the header chip
 * already shows the connected account.
 *
 * Also keeps the page in sync afterwards: account switches, chain switches
 * and disconnects (from the wallet or from the header menu) flow into the
 * provided callbacks.
 */
export function useWalletRestore(
  onRestore: (
    provider: Eip1193Provider | null,
    address: Address,
    chainId: number | null,
  ) => void,
  events: WalletEvents = {},
): void {
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const listen = (provider: Eip1193Provider) => {
      const onAccounts = (accountsChanged: unknown) => {
        const list = accountsChanged as string[];
        eventsRef.current.onAccountsChanged?.(
          (list?.[0] as Address | undefined) ?? null,
        );
      };
      const onChain = (next: unknown) => {
        eventsRef.current.onChainChanged?.(Number.parseInt(String(next), 16));
      };
      const onDisconnect = () => eventsRef.current.onDisconnect?.();
      provider.on?.("accountsChanged", onAccounts);
      provider.on?.("chainChanged", onChain);
      provider.on?.("disconnect", onDisconnect);
      cleanups.push(() => {
        provider.removeListener?.("accountsChanged", onAccounts);
        provider.removeListener?.("chainChanged", onChain);
        provider.removeListener?.("disconnect", onDisconnect);
      });
    };

    (async () => {
      // 1) Injected wallet — read-only probe, no popup.
      const eth = window.ethereum;
      if (eth) {
        listen(eth);
        try {
          const accounts = (await eth.request({
            method: "eth_accounts",
          })) as Address[];
          const account = accounts?.[0];
          if (account) {
            let chain: number | null = null;
            try {
              const idHex = (await eth.request({
                method: "eth_chainId",
              })) as string;
              chain = Number.parseInt(idHex, 16);
            } catch {
              /* chain unknown — leave blank */
            }
            if (!cancelled) onRestoreRef.current(null, account, chain);
            return;
          }
        } catch {
          /* fall through to WalletConnect */
        }
      }

      // 2) WalletConnect — restore a persisted session when one exists.
      if (!walletConnectEnabled()) return;
      const hasSession = Object.keys(localStorage).some((key) =>
        key.startsWith("wc@2:"),
      );
      if (!hasSession) return;

      try {
        const provider = await getWalletConnectProvider();
        if (cancelled) return;
        listen(provider);
        const accounts = (await provider.request({
          method: "eth_accounts",
        })) as Address[];
        const account = accounts?.[0];
        if (!cancelled && account) {
          let chain: number | null = null;
          try {
            const idHex = (await provider.request({
              method: "eth_chainId",
            })) as string;
            chain = Number.parseInt(idHex, 16);
          } catch {
            /* chain unknown — leave blank */
          }
          if (!cancelled) onRestoreRef.current(provider, account, chain);
        }
      } catch {
        /* no usable session — stay disconnected */
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanups) fn();
    };
  }, []);
}
