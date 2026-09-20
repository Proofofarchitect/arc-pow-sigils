"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  keccak256,
  parseEventLogs,
  parseGwei,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, ARC_RPC_URL, explorerUrl } from "@/lib/arc";
import { humanizeRpcError, rpcFetch } from "@/lib/rpc";
import {
  ARC_CHAIN_ID,
  CONTRACT_ADDRESS,
  POW_MINT_NFT_ABI,
} from "@/lib/contract";
import type { Eip1193Provider } from "@/lib/ethereum";
import { shortAddress } from "@/lib/format";
import { SITE_URL } from "@/lib/site";
import { TRAITS_IMAGE_QS } from "@/lib/traits-set";
import {
  disconnectWalletConnect,
  getWalletConnectProvider,
  walletConnectEnabled,
} from "@/lib/walletconnect";
import { useWalletRestore } from "@/lib/useWalletRestore";
import { HUNT_X_URL, ROOM_CONTENT, ROOMS } from "@/lib/rooms";

const MIN_FEE_GWEI = Number(
  process.env.NEXT_PUBLIC_MIN_MAX_FEE_GWEI ?? "50",
);
// Arc silently drops txs whose maxFeePerGas < 20 gwei (same rule as /mine).
const FEE_FLOOR_GWEI = Math.max(
  20,
  Number.isFinite(MIN_FEE_GWEI) ? MIN_FEE_GWEI : 50,
);

// WalletConnect is optional: enabled only when the build carries a project id.
const WC_ENABLED = walletConnectEnabled();

// Free-claim cards stay non-transferable until this wave (core LOCK_WAVES).
const LOCK_WAVES = 5;

const GITBOOK_CLAIM_URL =
  "https://proofofarchitect.gitbook.io/proof-of-architect/claim-codes";

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

type ClaimStats = {
  freeClaims: bigint;
  claimsLeft: bigint;
  codesAvailable: bigint;
  claimedCount: bigint;
  mintPaused: boolean;
};

/** Room answer → code: ledger check state for the derived 32-byte code. */
type DerivedStatus = null | "checking" | "unknown" | number;

/** max(floor, 2×baseFee); priority = half — identical to the /mine fee rule. */
async function computeFees(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  let maxFeePerGas = parseGwei(String(FEE_FLOOR_GWEI));
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 0n;
    const twice = baseFee * 2n;
    if (twice > maxFeePerGas) maxFeePerGas = twice;
  } catch {
    // keep the floor
  }
  return { maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas / 2n };
}

/**
 * A claim code is a raw 32-byte value: "0x" + 64 hex characters. Accept it
 * with or without the 0x prefix; anything else is not a code.
 */
function normalizeCode(raw: string): Hex | null {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  const withPrefix = /^0x/i.test(trimmed) ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? (withPrefix as Hex) : null;
}

function humanizeTxError(message: string): string {
  if (/user rejected|denied|User rejected/i.test(message)) {
    return "Transaction rejected in wallet.";
  }
  if (/InvalidCode/i.test(message)) {
    return "This code is invalid or was already used.";
  }
  if (/ClaimsOver/i.test(message)) {
    return "All free claim slots have been taken.";
  }
  if (/MintPaused/i.test(message)) {
    return "Claiming is paused by the project right now.";
  }
  if (/WrongPayment/i.test(message)) {
    return "Unexpected payment value — this is a client bug, please report it.";
  }
  return message;
}

const AGENT_SNIPPET = `// viem (Arc) — redeem a claim code
const hash = await walletClient.writeContract({
  address: "${CONTRACT_ADDRESS}",
  abi: [{ name: "claim", type: "function", stateMutability: "payable",
          inputs: [{ name: "code", type: "bytes32" }], outputs: [] }],
  functionName: "claim",
  args: [code],   // "0x" + 64 hex — single-use, keep it secret
  value: 0n,      // must be zero; gas only
});`;

export default function ClaimPage() {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Detected after mount so SSR HTML and first client render agree.
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

  const [stats, setStats] = useState<ClaimStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Refresh cooldown (seconds): same 4s guard as /mine, /stake, /points so a
  // repeated tap cannot burst the Arc RPC into rate-limiting.
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  const [codeInput, setCodeInput] = useState("");
  const [claimedTokenId, setClaimedTokenId] = useState<bigint | null>(null);

  // The Twelve Rooms: room answer (phrase) → code via keccak-256, checked on-chain.
  const [phraseInput, setPhraseInput] = useState("");
  const [derivedCode, setDerivedCode] = useState<Hex | null>(null);
  const [derivedStatus, setDerivedStatus] = useState<DerivedStatus>(null);
  // Bumped on every "Derive code" click so the ledger check re-runs even when
  // the derived code is the same as the previous one (no stuck "checking…").
  const [checkTick, setCheckTick] = useState(0);

  const refreshStats = useCallback(async () => {
    try {
      const [freeClaims, claimsLeft, codesAvailable, claimedCount, mintPaused] =
        await Promise.all([
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "freeClaims",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "claimsLeft",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "codesAvailable",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "claimedCount",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "mintPaused",
          }),
        ]);
      setStats({ freeClaims, claimsLeft, codesAvailable, claimedCount, mintPaused });
      setStatsError(null);
    } catch (e) {
      setStatsError(
        humanizeRpcError(
          e instanceof Error ? e.message : "Could not read claim state",
        ),
      );
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  // Manual refresh with a 4s cooldown — a burst of clicks is ignored instead
  // of hammering the Arc RPC (the old behaviour surfaced raw rate-limit errors).
  const handleRefresh = useCallback(() => {
    if (refreshCooldown > 0) return;
    void refreshStats();
    setRefreshCooldown(4);
  }, [refreshCooldown, refreshStats]);

  // Tick the refresh cooldown down to 0 once per second.
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
    setStatus("Opening WalletConnect…");
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
      provider.on?.("chainChanged", (nextChainId) => {
        setChainId(Number.parseInt(String(nextChainId), 16));
      });
      provider.on?.("disconnect", () => {
        setWcProvider(null);
        setAddress(null);
        setChainId(null);
      });

      setWcProvider(provider);
      setAddress(accounts[0] ?? null);
      setChainId(Number.parseInt(idHex, 16));
      setStatus("Connected via WalletConnect.");
    } catch (e) {
      setStatus("");
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
    setStatus("WalletConnect session closed.");
  }, []);

  const switchToArc = useCallback(async () => {
    const provider = wcProvider ?? window.ethereum;
    if (!provider) return;
    setError(null);
    const hexId = `0x${ARC_CHAIN_ID.toString(16)}`;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexId }],
      });
    } catch {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexId,
              chainName: arcTestnet.name,
              nativeCurrency: arcTestnet.nativeCurrency,
              rpcUrls: [ARC_RPC_URL],
              blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
            },
          ],
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not add Arc network");
      }
    }
    const idHex = (await provider.request({
      method: "eth_chainId",
    })) as string;
    setChainId(Number.parseInt(idHex, 16));
  }, [wcProvider]);

  // -------------------------------------------------------------- claim

  const claim = useCallback(async () => {
    setError(null);
    setTxHash(null);
    setClaimedTokenId(null);
    const code = normalizeCode(codeInput);
    if (!code) {
      setError(
        "A claim code is 32 bytes of hex — “0x” + 64 hex characters. Check the code and try again.",
      );
      return;
    }
    const provider = wcProvider ?? window.ethereum;
    if (!provider || !address) {
      setError("Connect your wallet first.");
      return;
    }
    setBusy(true);
    setStatus("claim() — sending…");
    try {
      const walletClient = createWalletClient({
        chain: arcTestnet,
        transport: custom(provider),
      });
      const fees = await computeFees();
      const hash = await walletClient.writeContract({
        account: address,
        address: CONTRACT_ADDRESS,
        abi: POW_MINT_NFT_ABI,
        functionName: "claim",
        args: [code],
        value: 0n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      setTxHash(hash);
      setStatus("claim submitted. Waiting for the receipt…");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
      if (receipt.status !== "success") {
        setError("claim transaction reverted on-chain.");
        setStatus("");
        return;
      }
      const claimedLogs = parseEventLogs({
        abi: POW_MINT_NFT_ABI,
        logs: receipt.logs,
        eventName: "Claimed",
      });
      const tokenId =
        claimedLogs.length > 0 ? (claimedLogs[0].args.tokenId as bigint) : null;
      if (tokenId !== null) {
        setClaimedTokenId(tokenId);
        setStatus(`Claimed Architector #${tokenId} (block ${receipt.blockNumber}).`);
      } else {
        setStatus(`Claim confirmed (block ${receipt.blockNumber}).`);
      }
      setCodeInput("");
      await refreshStats();
    } catch (e) {
      setError(humanizeTxError(e instanceof Error ? e.message : "claim failed"));
      setStatus("");
      await refreshStats();
    } finally {
      setBusy(false);
    }
  }, [address, codeInput, wcProvider, refreshStats]);

  // -------------------------------------------------------------- derive

  const wrongChain = chainId !== null && chainId !== ARC_CHAIN_ID;
  const codeValid = useMemo(() => normalizeCode(codeInput) !== null, [codeInput]);

  // ------------------------ the twelve rooms (phrase → code)
  const deriveFromPhrase = useCallback(() => {
    // Exact bytes on purpose: no trim — keccak is byte-strict, the door is strict.
    if (!phraseInput) {
      setDerivedCode(null);
      setDerivedStatus(null);
      return;
    }
    try {
      setDerivedCode(keccak256(toBytes(phraseInput)));
      setDerivedStatus("checking");
      setCheckTick((t) => t + 1);
    } catch {
      setDerivedCode(null);
      setDerivedStatus(null);
    }
  }, [phraseInput]);

  useEffect(() => {
    if (!derivedCode) return;
    let cancelled = false;
    (async () => {
      try {
        const key = keccak256(derivedCode);
        const st = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "codeStatus",
          args: [key],
        });
        if (!cancelled) setDerivedStatus(Number(st));
      } catch {
        if (!cancelled) setDerivedStatus("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [derivedCode, checkTick]);
  const blocked =
    stats !== null && (stats.codesAvailable === 0n || stats.mintPaused);

  return (
    <main className="container">
      <h1>Claim a free code</h1>
      <p className="muted">
        The House sets aside 42 free Cards — two doors lead to them. Most are
        gifted as claim codes handed out by the team; twelve are locked inside
        the Rooms, hidden across this page, its source, the architect’s notes
        and the chain itself. The entrance to each Room is posted on{" "}
        <a href={HUNT_X_URL} target="_blank" rel="noopener noreferrer">
          @proof_of_arc
        </a>
        . Claiming costs no mining and no payment — you only pay the network
        fee. Codes are single-use: keep yours secret until you claim it.
      </p>

      {statsError && (
        <div className="banner error">
          Could not read claim state from the chain: {statsError}
        </div>
      )}
      {stats !== null && stats.codesAvailable === 0n && (
        <div className="banner warn">
          No keys are activated right now. The House activates each key in the
          contract the moment its Room opens — gifted codes are switched on
          before they are handed out.
        </div>
      )}
      {stats?.mintPaused && (
        <div className="banner warn">Claiming is paused by the project.</div>
      )}

      {/* ----------------------------------------------------- wallet panel */}
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
        <div className="row">
          <span className="k">Core contract</span>
          <span className="v small">{CONTRACT_ADDRESS}</span>
        </div>

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
          ) : wrongChain ? (
            <button className="primary" onClick={switchToArc}>
              Switch to Arc
            </button>
          ) : (
            <>
              <button
                className="ghost"
                onClick={handleRefresh}
                disabled={refreshCooldown > 0}
              >
                {refreshCooldown > 0 ? `Refresh (${refreshCooldown}s)` : "Refresh"}
              </button>
              {wcProvider && (
                <button className="ghost" onClick={disconnectWc}>
                  Disconnect
                </button>
              )}
            </>
          )}
        </div>

        {wrongChain && (
          <div className="banner warn">
            Wrong network: connected to chain {chainId}. Arc is{" "}
            {ARC_CHAIN_ID}.{" "}
            <button className="link-btn" onClick={switchToArc}>
              switch/add chain
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ redeem */}
      <div className="panel">
        <h2>Redeem a code</h2>

        {!address ? (
          <div className="banner">
            Connect your wallet to redeem a code. The card mints straight to
            your address.
          </div>
        ) : claimedTokenId !== null ? (
          <div>
            <div className="banner ok">
              Card #{claimedTokenId.toString()} claimed. Welcome to the House.
            </div>
            <div
              style={{
                display: "flex",
                gap: 18,
                flexWrap: "wrap",
                marginTop: 14,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/image/${claimedTokenId}${TRAITS_IMAGE_QS}`}
                alt={`Architector #${claimedTokenId}`}
                width={256}
                height={256}
                style={{
                  imageRendering: "pixelated",
                  border: "2px solid var(--ink, #16222e)",
                }}
              />
              <div style={{ minWidth: 240, flex: "1 1 260px" }}>
                <p className="muted small" style={{ marginTop: 0 }}>
                  Free-claim cards are non-transferable until wave {LOCK_WAVES} (
                  {LOCK_WAVES} × 1,000 paid mints) — the card is still fully
                  yours, and its traits, rarity and golden overlay derive from
                  the claim. The code is burned and can never be used again.
                </p>
                <div className="field">
                  <Link className="button" href={`/token/${claimedTokenId}`}>
                    Open token page
                  </Link>
                  <button
                    className="ghost"
                    onClick={() => setClaimedTokenId(null)}
                  >
                    Redeem another code
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="0x… (32-byte code: 0x + 64 hex characters)"
                spellCheck={false}
                autoComplete="off"
                aria-label="Claim code"
                inputMode="text"
              />
              <button
                className="primary"
                onClick={claim}
                disabled={
                  !address || wrongChain || busy || !codeValid || blocked
                }
              >
                {busy ? "Working…" : "Claim card"}
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              The claim sends <span className="mono">claim(code)</span> with
              zero payment — gas only. Need USDC for gas?{" "}
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                faucet.circle.com
              </a>
              .
            </p>
          </>
        )}

        {status && (
          <div className="banner" style={{ marginTop: 10 }}>
            {status}
          </div>
        )}
        {error && (
          <div className="banner error" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        {txHash && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Transaction:{" "}
            <a
              className="mono"
              href={explorerUrl(`/tx/${txHash}`)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {txHash.slice(0, 20)}…
            </a>
          </p>
        )}
      </div>

      {/* ----------------------------------------------------- twelve rooms */}
      <div className="panel">
        <h2>The Twelve Rooms</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Twelve keys, twelve Rooms. Each Room is opened by an entrance post on{" "}
          <a href={HUNT_X_URL} target="_blank" rel="noopener noreferrer">
            @proof_of_arc
          </a>{" "}
          — its answer is assembled from pieces scattered across this page’s
          source, the architect’s notes (GitBook) and the chain. First key to
          the door keeps the Card.
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            margin: "12px 0 4px",
          }}
        >
          {ROOMS.map((r) => {
            const c = ROOM_CONTENT[r.n];
            const suffix =
              r.status === "solved" ? " ✓" : r.status === "sealed" ? " ·" : "";
            return (
              <span
                key={r.n}
                className={`pill ${r.status === "open" ? "ok" : "off"}`}
                title={c?.title ?? "sealed"}
              >
                {r.roman}
                {suffix}
              </span>
            );
          })}
        </div>

        {ROOMS.filter((r) => r.status === "open").map((r) => {
          const c = ROOM_CONTENT[r.n];
          if (!c) return null;
          return (
            <div key={r.n} style={{ marginTop: 16 }}>
              <h3 style={{ marginBottom: 6 }}>
                Room {r.roman} — {c.title}
              </h3>
              {c.visibleHint.map((p) => (
                <p key={p} className="muted small" style={{ marginTop: 0 }}>
                  {p}
                </p>
              ))}
              <p className="muted small" style={{ marginTop: 0 }}>
                Entrance post:{" "}
                <a href={HUNT_X_URL} target="_blank" rel="noopener noreferrer">
                  X / @proof_of_arc
                </a>{" "}
                ·{" "}
                <a
                  href={GITBOOK_CLAIM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitBook: Claim Codes
                </a>
              </p>
            </div>
          );
        })}

        <h3 style={{ marginBottom: 6 }}>Room answer → code</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Found a phrase? Hash it here (keccak-256 runs in your browser — the
          door is byte-strict: mind the case and the dashes), then check the
          ledger before you claim.
        </p>
        <div className="field">
          <input
            value={phraseInput}
            onChange={(e) => setPhraseInput(e.target.value)}
            placeholder="THRESHOLD-A-B-C (exact characters)"
            spellCheck={false}
            autoComplete="off"
            aria-label="Room answer phrase"
            inputMode="text"
          />
          <button className="ghost" onClick={deriveFromPhrase}>
            Derive code
          </button>
          {derivedCode && (
            <button
              className="ghost"
              onClick={() => setCodeInput(derivedCode)}
            >
              Use in redeem
            </button>
          )}
        </div>
        {derivedCode && (
          <div style={{ marginTop: 10 }}>
            <p className="muted small" style={{ marginTop: 0 }}>
              code:{" "}
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {derivedCode}
              </span>
            </p>
            <p className="muted small" style={{ marginTop: 0 }}>
              {derivedStatus === "checking" && "checking the ledger…"}
              {derivedStatus === null &&
                "hash computed in your browser — paste it in Redeem above."}
              {derivedStatus === "unknown" &&
                "could not read the ledger right now (RPC) — verify later or claim directly."}
              {derivedStatus === 0 &&
                "not registered on this contract — re-read the phrase (case, dashes, network)."}
              {derivedStatus === 1 &&
                "registered and unspent — the door will take it."}
              {derivedStatus === 2 && "already spent on-chain."}
            </p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ claim status */}
      <div className="panel">
        <h2>Claim status</h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Claims left</div>
            <div className="value">
              {stats
                ? `${stats.claimsLeft.toString()} / ${stats.freeClaims.toString()}`
                : "…"}
            </div>
          </div>
          <div className="stat">
            <div className="label">Codes available</div>
            <div className="value">
              {stats ? stats.codesAvailable.toString() : "…"}
            </div>
          </div>
          <div className="stat">
            <div className="label">Claimed so far</div>
            <div className="value">
              {stats ? stats.claimedCount.toString() : "…"}
            </div>
          </div>
          <div className="stat">
            <div className="label">Status</div>
            <div className="value">
              {stats === null
                ? "…"
                : stats.mintPaused
                  ? "paused"
                  : stats.codesAvailable > 0n
                    ? "ready"
                    : "waiting for codes"}
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------- claim vs mining */}
      <div className="panel">
        <h2>Claim vs mining</h2>
        <table className="claim-table">
          <thead>
            <tr>
              <th></th>
              <th>Free claim (code)</th>
              <th>Paid mint (mining)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Price</td>
              <td>0 USDC — network fee only</td>
              <td>1.0 USDC at wave 1, ×2 each wave</td>
            </tr>
            <tr>
              <td>Proof of work</td>
              <td>None</td>
              <td>Mine a keccak-256 nonce (browser or GPU)</td>
            </tr>
            <tr>
              <td>Supply</td>
              <td>42 free in total — twelve are Room keys</td>
              <td>15,000 paid mints</td>
            </tr>
            <tr>
              <td>Transferability</td>
              <td>Locked until wave {LOCK_WAVES} (free-token lock)</td>
              <td>Transferable immediately</td>
            </tr>
            <tr>
              <td>Access</td>
              <td>Gifted by the team, or the answer to a Room</td>
              <td>Open to everyone</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------------- for builders */}
      <div className="panel">
        <h2>For AI agents &amp; builders</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Claiming is a plain contract call — no API key, no backend. The remote
          MCP endpoint at{" "}
          <a href={`${SITE_URL}/api/mcp`}>{SITE_URL}/api/mcp</a> is read-only
          (stats, tokens, difficulty, nonce verification); redeeming a code needs
          a wallet or agent signer that holds the code:
        </p>
        <pre className="code-block">{AGENT_SNIPPET}</pre>
        <p className="muted small" style={{ marginTop: 0 }}>
          Codes are hashed on-chain (<span className="mono">
            keccak256(code)
          </span>
          ) — the raw code never touches the chain and cannot be recovered from
          it. Docs:{" "}
          <a href={`${SITE_URL}/docs/agent-access`}>agent access</a> ·{" "}
          <a
            href={GITBOOK_CLAIM_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitBook: Claim Codes
          </a>
          .
        </p>
      </div>

      {/* Room payloads — staged in the page source (see hunt spec §2).
          Visible via view-source / curl, never in the rendered UI. */}
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: ROOMS.filter(
            (r) => r.status === "open" && ROOM_CONTENT[r.n]?.sourceComment,
          )
            .map((r) => `<!-- ${ROOM_CONTENT[r.n].sourceComment} -->`)
            .join("\n"),
        }}
      />
    </main>
  );
}
