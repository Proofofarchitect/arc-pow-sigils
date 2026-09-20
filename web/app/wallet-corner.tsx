"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { explorerUrl } from "@/lib/arc";
import {
  disconnectWalletConnect,
  getWalletConnectProvider,
  walletConnectEnabled,
} from "@/lib/walletconnect";

/**
 * Header wallet corner — the common web3 pattern: once a wallet is connected
 * (injected or WalletConnect), a chip with the truncated address appears in
 * the top-right corner. Clicking it opens a small menu: copy address, view on
 * the explorer, disconnect.
 *
 * Intentionally self-contained: it reads `window.ethereum` / the WalletConnect
 * session directly and listens for account events, while pages keep their own
 * connect flows (they receive the same provider events).
 */

type Conn = { address: string; source: "injected" | "walletconnect" };

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function WalletCorner() {
  const [conn, setConn] = useState<Conn | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Injected wallet: read on mount, follow account switches / disconnects.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    let cancelled = false;

    const onAccounts = (accounts: unknown) => {
      if (cancelled) return;
      const list = Array.isArray(accounts) ? (accounts as string[]) : [];
      setConn((current) => {
        if (list[0]) return { address: list[0], source: "injected" };
        return current?.source === "injected" ? null : current;
      });
    };
    const onDisconnect = () =>
      setConn((current) => (current?.source === "injected" ? null : current));

    (async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        if (!cancelled && accounts?.[0]) {
          setConn({ address: accounts[0], source: "injected" });
        }
      } catch {
        /* keep the corner hidden */
      }
    })();

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("disconnect", onDisconnect);
    return () => {
      cancelled = true;
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("disconnect", onDisconnect);
    };
  }, []);

  // WalletConnect: restore an existing session (persisted as `wc@2:*` in
  // localStorage) and follow the same events on its provider.
  useEffect(() => {
    if (!walletConnectEnabled()) return;
    const hasSession = Object.keys(localStorage).some((key) =>
      key.startsWith("wc@2:"),
    );
    if (!hasSession) return;

    let cancelled = false;
    let provider: Awaited<ReturnType<typeof getWalletConnectProvider>> | null = null;

    const onAccounts = (accounts: unknown) => {
      if (cancelled) return;
      const list = Array.isArray(accounts) ? (accounts as string[]) : [];
      setConn((current) => {
        if (list[0]) return { address: list[0], source: "walletconnect" };
        return current?.source === "walletconnect" ? null : current;
      });
    };
    const onDisconnect = () =>
      setConn((current) => (current?.source === "walletconnect" ? null : current));

    getWalletConnectProvider()
      .then(async (p) => {
        if (cancelled) return;
        provider = p;
        p.on?.("accountsChanged", onAccounts);
        p.on?.("disconnect", onDisconnect);
        try {
          const accounts = (await p.request({ method: "eth_accounts" })) as string[];
          if (!cancelled && accounts?.[0]) {
            setConn({ address: accounts[0], source: "walletconnect" });
          }
        } catch {
          /* session exists but is not usable right now — stay hidden */
        }
      })
      .catch(() => {
        /* provider failed to init — stay hidden */
      });

    return () => {
      cancelled = true;
      provider?.removeListener?.("accountsChanged", onAccounts);
      provider?.removeListener?.("disconnect", onDisconnect);
    };
  }, []);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copy = useCallback(async () => {
    if (!conn) return;
    try {
      await navigator.clipboard.writeText(conn.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (permissions / non-secure context) */
    }
  }, [conn]);

  /**
   * Connect from the header: prefer an injected wallet, otherwise open the
   * WalletConnect QR pairing. If neither is available, guide to /mine where
   * the full console (and its guidance banner) lives.
   */
  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const eth = window.ethereum;
      if (eth) {
        const accounts = (await eth.request({
          method: "eth_requestAccounts",
        })) as string[];
        if (accounts?.[0]) setConn({ address: accounts[0], source: "injected" });
        return;
      }
      if (walletConnectEnabled()) {
        const provider = await getWalletConnectProvider();
        const onAccounts = (accounts: unknown) => {
          const list = Array.isArray(accounts) ? (accounts as string[]) : [];
          setConn((current) => {
            if (list[0]) return { address: list[0], source: "walletconnect" };
            return current?.source === "walletconnect" ? null : current;
          });
        };
        const onDisconnect = () =>
          setConn((current) =>
            current?.source === "walletconnect" ? null : current,
          );
        provider.on?.("accountsChanged", onAccounts);
        provider.on?.("disconnect", onDisconnect);
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        if (accounts?.[0]) {
          setConn({ address: accounts[0], source: "walletconnect" });
        }
        return;
      }
      window.location.assign("/mine");
    } catch {
      /* user rejected the request or the provider failed — stay disconnected */
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!conn) return;
    setOpen(false);
    if (conn.source === "walletconnect") {
      await disconnectWalletConnect();
    } else if (window.ethereum) {
      // EIP-1193 revoke (MetaMask & friends); best-effort for wallets without it.
      try {
        await window.ethereum.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      } catch {
        /* wallet does not support revocation — hide locally */
      }
    }
    setConn(null);
  }, [conn]);

  // Not connected: the corner always offers a connect button.
  if (!conn) {
    return (
      <div className="wallet-corner">
        <button
          type="button"
          className="button button-sm wallet-connect"
          onClick={connect}
          disabled={connecting}
          title="Connect a browser wallet or pair a mobile wallet via WalletConnect"
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-corner" ref={rootRef}>
      <button
        type="button"
        className="wallet-chip"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={conn.address}
      >
        <span className="wallet-dot" aria-hidden="true" />
        <span>{shortAddress(conn.address)}</span>
      </button>

      {open && (
        <div className="wallet-menu" role="menu">
          <Link href="/profile" role="menuitem" onClick={() => setOpen(false)}>
            My profile
          </Link>
          <button type="button" role="menuitem" onClick={copy}>
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <a
            role="menuitem"
            href={explorerUrl(`address/${conn.address}`)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on ArcScan ↗
          </a>
          <button
            type="button"
            role="menuitem"
            className="wallet-danger"
            onClick={disconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
