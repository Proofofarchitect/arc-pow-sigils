"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import type { Eip1193Provider } from "@/lib/ethereum";
import { shortAddress } from "@/lib/format";
import { humanizeRpcError } from "@/lib/rpc";
import { ARC_CHAIN_ID } from "@/lib/contract";
import { SITE_URL } from "@/lib/site";
import { POINT_RULES, type PointsSnapshot, type WalletPoints } from "@/lib/points";
import {
  disconnectWalletConnect,
  getWalletConnectProvider,
  walletConnectEnabled,
} from "@/lib/walletconnect";
import { useWalletRestore } from "@/lib/useWalletRestore";

const WC_ENABLED = walletConnectEnabled();

const GITBOOK_LEGAL =
  "https://proofofarchitect.gitbook.io/proof-of-architect/project/legal-disclaimer";

type RulesRow = {
  action: string;
  points: number;
  who: string;
};

const RULES_ROWS: RulesRow[] = [
  {
    action: "Mine a card (paid mint)",
    points: POINT_RULES.mine,
    who: "The miner who submitted the winning nonce",
  },
  {
    action: "Redeem a free claim code",
    points: POINT_RULES.claim,
    who: "The wallet that claimed",
  },
  {
    action: "Craft a card (forge)",
    points: POINT_RULES.forge,
    who: "The wallet behind the reveal",
  },
  {
    action: "Burn a card",
    points: POINT_RULES.burn,
    who: "The wallet that burned",
  },
];

function downloadJson(data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "proofofarchitect-points.json";
  a.click();
  URL.revokeObjectURL(url);
}

export default function PointsPage() {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [hasInjected, setHasInjected] = useState(false);
  const [wcProvider, setWcProvider] = useState<Eip1193Provider | null>(null);

  // Restore an already-authorized wallet on load (no popups) so the page never
  // asks to connect again while the header already shows the account.
  useWalletRestore(
    (provider, restoredAddress, restoredChain) => {
      if (provider) setWcProvider(provider);
      setAddress(restoredAddress);
      setChainId(restoredChain);
    },
    {
      onAccountsChanged: (next) => {
        setAddress(next);
        if (!next) setWcProvider(null);
      },
      onChainChanged: (next) => setChainId(next),
      onDisconnect: () => {
        setWcProvider(null);
        setAddress(null);
        setChainId(null);
      },
    },
  );

  useEffect(() => {
    setHasInjected(!!window.ethereum);
  }, []);

  const [board, setBoard] = useState<PointsSnapshot | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [myPoints, setMyPoints] = useState<WalletPoints | null>(null);
  const [loading, setLoading] = useState(false);

  // `Refresh` cooldown (seconds): mirrors the mine page so a repeated tap
  // cannot spam the endpoint (and the RPC scan behind it) into rate-limiting.
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/points", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        computedAtBlock: number;
        totals: PointsSnapshot["totals"];
        wallets: WalletPoints[];
      };
      setBoard({
        computedAtBlock: data.computedAtBlock,
        totals: data.totals,
        wallets: data.wallets,
      });
      setBoardError(null);
    } catch (e) {
      setBoardError(
        humanizeRpcError(
          e instanceof Error ? e.message : "Could not load points",
        ),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMine = useCallback(async (who: string) => {
    try {
      // Reuse the full snapshot (single edge-cache entry) instead of a
      // per-address URL variant, which would each pay a cold scan.
      const res = await fetch("/api/points", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { wallets: WalletPoints[] };
      const found = data.wallets.find(
        (w) => w.address === who.toLowerCase(),
      );
      setMyPoints(
        found ?? {
          address: who.toLowerCase(),
          mined: 0,
          claimed: 0,
          forged: 0,
          burned: 0,
          points: 0,
        },
      );
    } catch {
      setMyPoints(null);
    }
  }, []);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (address) void loadMine(address);
    else setMyPoints(null);
  }, [address, loadMine]);

  /** Manual `Refresh` (leaderboard): 4s cooldown + not-while-loading guard. */
  const manualRefresh = useCallback(() => {
    if (refreshCooldown > 0 || loading) return;
    void loadBoard();
    setRefreshCooldown(4);
  }, [refreshCooldown, loading, loadBoard]);

  // Tick the Refresh cooldown down once per second.
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const handle = setInterval(() => {
      setRefreshCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(handle);
  }, [refreshCooldown]);

  // -------------------------------------------------------------- wallet

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError(
        "No injected wallet found. Install a browser wallet or use WalletConnect.",
      );
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const idHex = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;
      setAddress(accounts[0] ?? null);
      setChainId(Number.parseInt(idHex, 16));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection rejected");
    }
  }, []);

  const connectWalletConnect = useCallback(async () => {
    setError(null);
    if (!WC_ENABLED) {
      setError(
        "WalletConnect is not configured in this build (missing project id).",
      );
      return;
    }
    try {
      const provider = await getWalletConnectProvider();
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const idHex = (await provider.request({
        method: "eth_chainId",
      })) as string;
      provider.on?.("accountsChanged", (accountsChanged) => {
        const list = accountsChanged as string[];
        setAddress((list?.[0] as Address | undefined) ?? null);
        if (!list?.length) setWcProvider(null);
      });
      provider.on?.("disconnect", () => {
        setWcProvider(null);
        setAddress(null);
        setChainId(null);
      });
      setWcProvider(provider);
      setAddress(accounts[0] ?? null);
      setChainId(Number.parseInt(idHex, 16));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "WalletConnect connection failed",
      );
    }
  }, []);

  const disconnectWc = useCallback(async () => {
    await disconnectWalletConnect();
    setWcProvider(null);
    setAddress(null);
    setChainId(null);
  }, []);

  // -------------------------------------------------------------- render

  const wrongChain = chainId !== null && chainId !== ARC_CHAIN_ID;

  return (
    <main className="container">
      <h1>House Points — Season 1</h1>
      <p className="muted">
        Points are earned by using the collection: mining, claiming, crafting
        and burning. They are computed from public on-chain events — anyone can
        recompute them from the same events, so nothing is taken on trust.
      </p>

      {boardError && (
        <div className="banner error">Could not load points: {boardError}</div>
      )}

      {/* ----------------------------------------------------- my points */}
      <div className="panel">
        <div className="row">
          <span className="k">Wallet</span>
          <span className="v">
            {address ? (
              <>
                {shortAddress(address)}{" "}
                <span className={`pill ${!wrongChain ? "ok" : "off"}`}>
                  chain {chainId ?? "?"}
                </span>
              </>
            ) : (
              "not connected"
            )}
          </span>
        </div>
        {address && myPoints && (
          <div className="stat-grid">
            <div className="stat">
              <div className="label">Your points</div>
              <div className="value">{myPoints.points}</div>
            </div>
            <div className="stat">
              <div className="label">Mined</div>
              <div className="value">{myPoints.mined}</div>
            </div>
            <div className="stat">
              <div className="label">Claimed</div>
              <div className="value">{myPoints.claimed}</div>
            </div>
            <div className="stat">
              <div className="label">Crafted</div>
              <div className="value">{myPoints.forged}</div>
            </div>
            <div className="stat">
              <div className="label">Burned</div>
              <div className="value">{myPoints.burned}</div>
            </div>
          </div>
        )}
        <div className="field">
          {!address ? (
            <>
              <button
                className={hasInjected ? "primary" : "ghost"}
                onClick={connect}
              >
                Connect wallet
              </button>
              <button
                className={hasInjected ? "ghost" : "primary"}
                onClick={connectWalletConnect}
                disabled={!WC_ENABLED}
                title={
                  WC_ENABLED
                    ? "Pair a mobile wallet by QR (WalletConnect)"
                    : "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable WalletConnect"
                }
              >
                WalletConnect (QR)
              </button>
            </>
          ) : (
            <>
              <button
                className="ghost"
                onClick={manualRefresh}
                disabled={refreshCooldown > 0}
              >
                {refreshCooldown > 0
                  ? `Refresh (${refreshCooldown}s)`
                  : "Refresh"}
              </button>
              {wcProvider && (
                <button className="ghost" onClick={disconnectWc}>
                  Disconnect
                </button>
              )}
            </>
          )}
        </div>
        {error && (
          <div className="banner error" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      {/* --------------------------------------------------- season note */}
      <div className="panel">
        <h2>Season 1 → rewards</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Season 1 points are planned to convert into <strong>PARC
          rewards</strong> — conversion details will be announced in advance of
          a distribution. No guarantees are made, the program can change, and
          points have no monetary value until (and unless) a distribution
          happens. This is not an investment offer. See the{" "}
          <a href={GITBOOK_LEGAL} target="_blank" rel="noopener noreferrer">
            legal disclaimer
          </a>
          .
        </p>
        <p className="muted small">
          Points are not transferable and live off-chain: they can be exported
          any time —{" "}
          <a
            href="/api/points"
            onClick={(e) => {
              e.preventDefault();
              if (board) downloadJson(board);
            }}
          >
            download the dataset (JSON)
          </a>
          . Agents read it from{" "}
          <a href="/api/points">
            <span className="mono">/api/points</span>
          </a>
          .
        </p>
      </div>

      {/* -------------------------------------------------- rules table */}
      <div className="panel">
        <h2>How points are earned</h2>
        <table className="claim-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Points</th>
              <th>Who earns</th>
            </tr>
          </thead>
          <tbody>
            {RULES_ROWS.map((row) => (
              <tr key={row.action}>
                <td>{row.action}</td>
                <td className="mono">+{row.points}</td>
                <td>{row.who}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Every count comes from the contract&apos;s event log; the rules are
          public and fixed for Season 1. HDD Season (proof of space) will add a
          third way to earn.
        </p>
      </div>

      {/* ---------------------------------------------------- leaderboard */}
      <div className="panel">
        <h2>Leaderboard</h2>
        {board === null ? (
          <div className="banner">{loading ? "Loading…" : "No data yet."}</div>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {board.totals.wallets} wallets · {board.totals.points} points
              total · computed at block{" "}
              <span className="mono">{board.computedAtBlock}</span>
            </p>
            {board.wallets.length === 0 ? (
              <div className="banner">
                No activity yet — mine the first card to appear here.
              </div>
            ) : (
              <table className="claim-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Wallet</th>
                    <th>Points</th>
                    <th>Mined</th>
                    <th>Claimed</th>
                    <th>Crafted</th>
                    <th>Burned</th>
                  </tr>
                </thead>
                <tbody>
                  {board.wallets.slice(0, 50).map((w, i) => (
                    <tr key={w.address}>
                      <td>{i + 1}</td>
                      <td className="mono">{shortAddress(w.address)}</td>
                      <td className="mono">{w.points}</td>
                      <td>{w.mined}</td>
                      <td>{w.claimed}</td>
                      <td>{w.forged}</td>
                      <td>{w.burned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* ------------------------------------------------------ for agents */}
      <div className="panel">
        <h2>For AI agents &amp; builders</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          The dataset is fully machine-readable and recomputable:{" "}
          <span className="mono">GET {SITE_URL}/api/points</span> (all wallets,{" "}
          <span className="mono">?address=0x…</span> for one). Registered
          agents and their ranking live at{" "}
          <a href="/agents">
            <span className="mono">/agents</span>
          </a>
          . Everything above can be derived from the four core events —
          no API key, no accounts.
        </p>
      </div>
    </main>
  );
}
