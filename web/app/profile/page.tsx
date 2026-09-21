"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, type Address } from "viem";
import { arcTestnet, ARC_RPC_URL, explorerUrl } from "@/lib/arc";
import { rpcFetch } from "@/lib/rpc";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "@/lib/contract";
import { readDisplaySeed } from "@/lib/display-seed";
import { milliToBits } from "@/lib/pow";
import { rarityForSeed, type RarityTier } from "@/lib/rarity";
import { rarityForSeedV2 } from "@/lib/rarity_v2";
import { IS_V2, imageQuery } from "@/lib/traits-set";
import { useWalletRestore } from "@/lib/useWalletRestore";
import { STAKE_TIERS, VAULT_ABI, VAULT_ADDRESS } from "@/lib/staking";
import { formatUsdc } from "@/lib/format";
import {
  getWalletConnectProvider,
  walletConnectEnabled,
} from "@/lib/walletconnect";

/**
 * /profile — the connected wallet's dashboard: every card it holds (mined and
 * crafted children), what is staked in the vault, and the wallet's on-chain
 * stats (house points, current mining difficulty, collection progress).
 *
 * All data is public chain state read through the same public client the rest
 * of the site uses — no extra API surface. Card rarity is computed locally
 * from the on-chain seed (`rarityForSeed`, same math as elsewhere).
 */

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

/** Forge id namespace on the core (PowMintNFTv3_1.FORGE_ID_BASE). */
const FORGE_ID_BASE = 10_000_000;
/** Ownership scan bound — same convention as /craft and /stake. */
const SCAN_CAP = 500;
const SCAN_CONCURRENCY = 8;

/** Core reads that the shared minimal ABI does not carry. */
const PROFILE_CORE_ABI = [
  {
    type: "function",
    name: "totalForged",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalBurned",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isFreeToken",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type WalletPoints = {
  address: string;
  mined: number;
  claimed: number;
  forged: number;
  burned: number;
  points: number;
};

type CardRow = {
  id: number;
  crafted: boolean;
  free: boolean;
  tier: RarityTier | null;
};

type StakedRow = {
  id: number;
  tier: number;
  crafted: boolean;
  rarity: RarityTier | null;
};

type Summary = {
  totalMinted: number;
  totalForged: number;
  totalBurned: number;
  wave: bigint;
  price: bigint;
  baseBits: number;
  maxSupply: number;
};

function Card({
  row,
  stakedTier,
}: {
  row: CardRow;
  stakedTier?: number;
}) {
  const [broken, setBroken] = useState(false);
  const number = `#${String(row.id).padStart(4, "0")}`;
  const stakeTier =
    stakedTier !== undefined
      ? STAKE_TIERS.find((tier) => tier.id === stakedTier)
      : undefined;

  return (
    <Link href={`/token/${row.id}`} className="collectible">
      <div className="collectible-art">
        {broken ? (
          <div className="thumb-fallback" aria-label={`Token ${row.id}`}>
            {number}
            <br />
            image pending
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="thumb"
            src={`/api/image/${row.id}${imageQuery(384)}`}
            alt={`Proof of Architect ${number}`}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        )}
      </div>
      <div className="collectible-meta">
        <div>
          <span className="collectible-number">{number}</span>
          <h3>Architect {number}</h3>
          <p>{row.crafted ? "forged via HC/2 craft" : "mined via proof-of-work"}</p>
        </div>
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
          }}
        >
          {stakeTier && (
            <span className="badge">Staked · {stakeTier.label}</span>
          )}
          {row.crafted && <span className="badge badge-crafted">Crafted</span>}
          {row.free && <span className="badge">Free claim</span>}
          {row.tier && (
            <span className={`badge tier-${row.tier.toLowerCase()}`}>
              {row.tier}
            </span>
          )}
        </span>
      </div>
    </Link>
  );
}

export default function ProfilePage() {
  const [address, setAddress] = useState<Address | null>(null);
  const [hasInjected, setHasInjected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [walletBits, setWalletBits] = useState<{
    required: number;
    discountMilli: number;
  } | null>(null);
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [staked, setStaked] = useState<StakedRow[] | null>(null);
  const [points, setPoints] = useState<WalletPoints | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });

  // `Refresh` cooldown (seconds). A single tap starts the countdown so an
  // impatient user cannot hammer the RPC into rate-limiting (same pattern as /mine).
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  useEffect(() => {
    setHasInjected(!!window.ethereum);
  }, []);

  // Silent reconnect: injected first, then a persisted WalletConnect session.
  useWalletRestore(
    (_provider, restored) => setAddress(restored),
    {
      onAccountsChanged: (next) => setAddress(next),
      onDisconnect: () => setAddress(null),
    },
  );

  // ------------------------------------------------------------- reads

  const loadBase = useCallback(async (): Promise<Summary | null> => {
    try {
      const [totalMinted, totalForged, totalBurned, wave, price, baseBits, maxSupply] =
        await Promise.all([
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "totalMinted",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: PROFILE_CORE_ABI,
            functionName: "totalForged",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: PROFILE_CORE_ABI,
            functionName: "totalBurned",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "currentWave",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "currentPrice",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "baseBits",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "maxSupply",
          }),
        ]);
      const snapshot: Summary = {
        totalMinted: Number(totalMinted),
        totalForged: Number(totalForged),
        totalBurned: Number(totalBurned),
        wave,
        price,
        baseBits: Number(baseBits),
        maxSupply: Number(maxSupply),
      };
      setSummary(snapshot);
      return snapshot;
    } catch {
      setSummary(null);
      return null;
    }
  }, []);

  const loadWalletBits = useCallback(async (who: Address) => {
    let required = 0;
    let discountMilli = 0;
    try {
      const milli = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: POW_MINT_NFT_ABI,
        functionName: "requiredMilli",
        args: [who],
      });
      required = milliToBits(milli);
    } catch {
      /* leave 0 */
    }
    try {
      discountMilli = Number(
        await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: POW_MINT_NFT_ABI,
          functionName: "stakingDiscountMilli",
          args: [who],
        }),
      );
    } catch {
      /* no boost configured — fine */
    }
    setWalletBits({ required, discountMilli });
  }, []);

  const scanCards = useCallback(
    async (who: Address, totalMinted: number, totalForged: number) => {
      setScanning(true);
      setCards(null);
      try {
        const upper = Math.min(totalMinted, SCAN_CAP);
        const targets: Array<{ id: number; crafted: boolean }> = [];
        for (let id = upper; id >= 1; id--) targets.push({ id, crafted: false });
        for (let i = totalForged - 1; i >= 0; i--) {
          targets.push({ id: FORGE_ID_BASE + i, crafted: true });
        }
        setScanProgress({ done: 0, total: targets.length });

        const owned: Array<{ id: number; crafted: boolean }> = [];
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (true) {
            const index = next++;
            if (index >= targets.length) return;
            const target = targets[index];
            try {
              const owner = await publicClient.readContract({
                address: CONTRACT_ADDRESS,
                abi: POW_MINT_NFT_ABI,
                functionName: "ownerOf",
                args: [BigInt(target.id)],
              });
              if (owner.toLowerCase() === who.toLowerCase()) owned.push(target);
            } catch {
              /* burned or missing — skip silently */
            }
            done += 1;
            if (done % 5 === 0 || done === targets.length) {
              setScanProgress({ done, total: targets.length });
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(SCAN_CONCURRENCY, targets.length) },
            worker,
          ),
        );
        owned.sort((a, b) => b.id - a.id);

        // Enrich: seed -> local rarity; free-claim flag (tolerated on v3).
        const rows: CardRow[] = owned.map((target) => ({
          id: target.id,
          crafted: target.crafted,
          free: false,
          tier: null,
        }));
        let enext = 0;
        const enrich = async () => {
          while (true) {
            const index = enext++;
            if (index >= rows.length) return;
            const row = rows[index];
            try {
              const { displaySeed } = await readDisplaySeed(
                publicClient,
                BigInt(row.id),
              );
              row.tier = (
                IS_V2 ? rarityForSeedV2(displaySeed) : rarityForSeed(displaySeed)
              ).tier;
            } catch {
              /* no seed (race right after mint) — no badge */
            }
            try {
              row.free = await publicClient.readContract({
                address: CONTRACT_ADDRESS,
                abi: PROFILE_CORE_ABI,
                functionName: "isFreeToken",
                args: [BigInt(row.id)],
              });
            } catch {
              /* stays false */
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(SCAN_CONCURRENCY, rows.length) },
            enrich,
          ),
        );
        setCards(rows);
      } finally {
        setScanning(false);
      }
    },
    [],
  );

  const loadStaked = useCallback(async (who: Address) => {
    if (!VAULT_ADDRESS) {
      setStaked([]);
      return;
    }
    try {
      const ids = await publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "stakesOf",
        args: [who],
      });
      const rows: StakedRow[] = [];
      for (const rawId of ids) {
        const id = Number(rawId);
        let tier = 0;
        try {
          const info = await publicClient.readContract({
            address: VAULT_ADDRESS,
            abi: VAULT_ABI,
            functionName: "stakeInfo",
            args: [BigInt(id)],
          });
          // Tuple getter: [owner, tier, stakedAt, accrued, lastAccrual].
          tier = Number(info[1]);
        } catch {
          /* unknown tier — show as flexible */
        }
        let rarity: RarityTier | null = null;
        try {
          const { displaySeed } = await readDisplaySeed(publicClient, BigInt(id));
          rarity = (
            IS_V2 ? rarityForSeedV2(displaySeed) : rarityForSeed(displaySeed)
          ).tier;
        } catch {
          /* no badge */
        }
        rows.push({ id, tier, crafted: id >= FORGE_ID_BASE, rarity });
      }
      rows.sort((a, b) => b.id - a.id);
      setStaked(rows);
    } catch {
      setStaked([]);
    }
  }, []);

  const loadPoints = useCallback(async (who: Address) => {
    try {
      const res = await fetch(`/api/points?address=${who}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { wallet?: WalletPoints };
      setPoints(data.wallet ?? null);
    } catch {
      setPoints(null);
    }
  }, []);

  const refresh = useCallback(
    async (who: Address) => {
      setError(null);
      const snapshot = await loadBase();
      await Promise.all([
        loadWalletBits(who),
        loadStaked(who),
        loadPoints(who),
        snapshot
          ? scanCards(who, snapshot.totalMinted, snapshot.totalForged)
          : Promise.resolve(),
      ]);
    },
    [loadBase, loadStaked, loadPoints, loadWalletBits, scanCards],
  );

  /**
   * Manual `Refresh`: guarded by a 4s cooldown (and the scanning flag) so a
   * rapid tap cannot spam the RPC into rate-limiting.
   */
  const handleRefresh = useCallback(() => {
    if (refreshCooldown > 0 || scanning) return;
    if (address) refresh(address);
    setRefreshCooldown(4);
  }, [refreshCooldown, scanning, address, refresh]);

  // Tick the Refresh cooldown down once per second.
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const handle = setInterval(() => {
      setRefreshCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(handle);
  }, [refreshCooldown]);

  useEffect(() => {
    if (!address) {
      setCards(null);
      setStaked(null);
      setPoints(null);
      setWalletBits(null);
      return;
    }
    refresh(address);
  }, [address, refresh]);

  // ------------------------------------------------------------ wallet

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const eth = window.ethereum;
      if (eth) {
        const accounts = (await eth.request({
          method: "eth_requestAccounts",
        })) as Address[];
        if (accounts?.[0]) setAddress(accounts[0]);
        return;
      }
      if (walletConnectEnabled()) {
        const provider = await getWalletConnectProvider();
        provider.on?.("accountsChanged", (list: unknown) => {
          const next = list as string[];
          setAddress((next?.[0] as Address | undefined) ?? null);
        });
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as Address[];
        if (accounts?.[0]) setAddress(accounts[0]);
        return;
      }
      window.location.assign("/mine");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed");
    } finally {
      setConnecting(false);
    }
  }, []);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [address]);

  // -------------------------------------------------------------- view

  const owned = cards ?? [];
  const stakedRows = staked ?? [];
  const loaded = cards !== null;
  const craftedCount = owned.filter((card) => card.crafted).length;

  return (
    <main className="container">
      <h1>My profile</h1>

      {!address ? (
        <div className="panel">
          <p className="muted small">
            Connect your wallet to see every card it holds, what is staked, and
            the wallet&apos;s on-chain stats. Minting wallets can also claim a
            free code on <Link href="/claim">/claim</Link>.
          </p>
          <div className="chip-row">
            <button
              type="button"
              className="button"
              onClick={connect}
              disabled={connecting}
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          </div>
          {error && <div className="banner error">{error}</div>}
        </div>
      ) : (
        <>
          <p className="mono small" style={{ wordBreak: "break-all" }}>
            {address}
          </p>
          <div className="chip-row">
            <button type="button" className="chip" onClick={copyAddress}>
              {copied ? "Copied ✓" : "Copy address"}
            </button>
            <a
              className="chip"
              href={explorerUrl(`address/${address}`)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on ArcScan ↗
            </a>
            <button
              type="button"
              className="chip"
              onClick={handleRefresh}
              disabled={refreshCooldown > 0 || scanning}
            >
              {scanning
                ? `Scanning… ${scanProgress.done}/${scanProgress.total}`
                : refreshCooldown > 0
                  ? `Refresh (${refreshCooldown}s)`
                  : "Refresh"}
            </button>
          </div>

          <section className="stats-band" aria-label="Wallet statistics">
            <div className="stat-grid">
              <div className="stat">
                <span className="label">Cards in wallet</span>
                <span className="value">{loaded ? owned.length : "…"}</span>
              </div>
              <div className="stat">
                <span className="label">Staked in vault</span>
                <span className="value">{staked ? stakedRows.length : "…"}</span>
              </div>
              <div className="stat">
                <span className="label">Crafted children</span>
                <span className="value">{loaded ? craftedCount : "…"}</span>
              </div>
              <div className="stat">
                <span className="label">House points</span>
                <span className="value">{points ? points.points : "…"}</span>
              </div>
              <div className="stat">
                <span className="label">Next mint difficulty</span>
                <span className="value">
                  {walletBits ? `${walletBits.required} bits` : "…"}
                </span>
                {walletBits && walletBits.discountMilli > 0 && (
                  <span className="small muted">
                    staking boost −{(walletBits.discountMilli / 1000).toFixed(1)}{" "}
                    bits
                  </span>
                )}
              </div>
            </div>
          </section>

          <p className="muted small">
            {points ? (
              <>
                Points breakdown — mined {points.mined} × 100 · claimed{" "}
                {points.claimed} × 50 · crafted {points.forged} × 150 · burned{" "}
                {points.burned} × 30 = <strong>{points.points}</strong> pts.{" "}
                <Link href="/points">Leaderboard →</Link>
              </>
            ) : (
              <>House points are computed from on-chain events (see /points).</>
            )}
            {summary && (
              <>
                {" "}
                · Wave {summary.wave.toString()} · mint price{" "}
                {formatUsdc(summary.price)} USDC · collection{" "}
                {summary.totalMinted}/{summary.maxSupply}
              </>
            )}
          </p>

          <section className="panel">
            <div className="panel-heading">
              <h2>Your cards</h2>
              <span className="muted small">
                {loaded
                  ? `${owned.length} in wallet · ${stakedRows.length} staked`
                  : scanning
                    ? "scanning the collection…"
                    : "…"}
              </span>
            </div>
            {loaded && owned.length === 0 && (
              <p className="muted small">
                No cards in this wallet yet — <Link href="/mine">mine one</Link>{" "}
                (takes seconds with the browser miner) or{" "}
                <Link href="/claim">claim a code</Link>.
              </p>
            )}
            <div className="grid">
              {owned.map((card) => (
                <Card key={card.id} row={card} />
              ))}
            </div>
          </section>

          {staked && stakedRows.length > 0 && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Staked in the vault</h2>
                <span className="muted small">
                  held by the StakingVault until unstake (tier lock applies —
                  each tier grants its own −2/−4/−6 bit mining boost)
                </span>
              </div>
              <div className="grid">
                {stakedRows.map((row) => (
                  <Card
                    key={row.id}
                    row={{
                      id: row.id,
                      crafted: row.crafted,
                      free: false,
                      tier: row.rarity,
                    }}
                    stakedTier={row.tier}
                  />
                ))}
              </div>
            </section>
          )}

          {error && <div className="banner error">{error}</div>}
        </>
      )}
    </main>
  );
}
