"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { createPublicClient, http } from "viem";
import { arcTestnet, ARC_RPC_URL } from "@/lib/arc";
import { rpcFetch } from "@/lib/rpc";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "@/lib/contract";
import { readDisplaySeed } from "@/lib/display-seed";
import { formatUsdc } from "@/lib/format";
import { rarityForSeed, type RarityTier } from "@/lib/rarity";
import { rarityForSeedV2 } from "@/lib/rarity_v2";
import { IS_V2, imageQuery } from "@/lib/traits-set";
import { PREVIEW_CAP, previewCardMeta } from "@/lib/preview";
import LiveFeed from "./live-feed";

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

/**
 * Rarity showcase limits. The collection grid renders every minted id by
 * default (no extra RPC). Tier filtering / rarity sorting is lazy: it is only
 * triggered on first user activation, then reads `seedOf` for the FIRST
 * RARITY_CAP minted tokens with a bounded concurrency — older tokens are not
 * analyzed (noted in the UI).
 */
const RARITY_CAP = 500;
const RARITY_CONCURRENCY = 8;

const TIERS: readonly RarityTier[] = [
  "Standard",
  "Notable",
  "Rare",
  "Epic",
  "Mythic",
];

type TierFilter = RarityTier | "All";

type RarityInfo = { score: number; tier: RarityTier };

type Summary = {
  totalMinted: bigint;
  maxSupply: bigint;
  freeClaims: bigint;
  claimsLeft: bigint;
  wave: bigint;
  price: bigint;
};

function TokenCard({
  id,
  tier,
  preview,
}: {
  id: number;
  tier?: RarityTier;
  preview?: boolean;
}) {
  // The canonical image source is our deterministic renderer. If the contract's
  // own tokenURI is later re-pointed at this deployment, it resolves to the same
  // SVG. We keep /api/image as the primary src and fall back to a placeholder
  // when a token is not yet renderable (e.g. race right after mint).
  const [broken, setBroken] = useState(false);
  const number = `#${String(id).padStart(4, "0")}`;

  return (
    <Link href={`/token/${id}`} className="collectible">
      <div className="collectible-art">
        {broken ? (
          <div className="thumb-fallback" aria-label={`Token ${id}`}>
            {number}
            <br />
            image pending
          </div>
        ) : (
          // next/image downscales the deterministic PNG to the grid tile size
          // (instead of shipping the full 1024px file per card).
          <Image
            className="thumb"
            src={`/api/image/${id}${imageQuery(384)}`}
            alt={`Proof of Architect #${id}`}
            width={1024}
            height={1024}
            sizes="(max-width: 700px) 92vw, (max-width: 1000px) 46vw, 340px"
            onError={() => setBroken(true)}
          />
        )}
      </div>
      <div className="collectible-meta">
        <div>
          <span className="collectible-number">{number}</span>
          <h3>Architector {number}</h3>
          <p>{preview ? "preview — not minted" : "seed-derived art"}</p>
        </div>
        {preview ? (
          <span className="badge badge-preview">Preview</span>
        ) : (
          tier && (
            <span className={`badge tier-${tier.toLowerCase()}`}>{tier}</span>
          )
        )}
      </div>
    </Link>
  );
}

export default function CollectionPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Rarity showcase state (all lazy — nothing fetched until activated).
  const [filter, setFilter] = useState<TierFilter>("All");
  const [sortByRarity, setSortByRarity] = useState(false);
  const [rarity, setRarity] = useState<Map<number, RarityInfo | null> | null>(
    null,
  );
  const [rarityLoading, setRarityLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [totalMinted, maxSupply, freeClaims, claimsLeft, wave, price] =
          await Promise.all([
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: POW_MINT_NFT_ABI,
              functionName: "totalMinted",
            }),
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: POW_MINT_NFT_ABI,
              functionName: "maxSupply",
            }),
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
              functionName: "currentWave",
            }),
            publicClient.readContract({
              address: CONTRACT_ADDRESS,
              abi: POW_MINT_NFT_ABI,
              functionName: "currentPrice",
            }),
          ]);

        if (!cancelled) {
          setSummary({ totalMinted, maxSupply, freeClaims, claimsLeft, wave, price });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to read contract");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalMinted = summary ? Number(summary.totalMinted) : 0;

  // All minted ids, newest first (unchanged default grid order).
  const ids = useMemo(
    () => Array.from({ length: totalMinted }, (_, i) => totalMinted - i),
    [totalMinted],
  );

  // Preview window (testnet / pre-launch): the grid fills up to PREVIEW_CAP
  // with deterministic preview cards until real mints take over (0 = off).
  const gridCount = Math.max(totalMinted, PREVIEW_CAP);
  const gridIds = useMemo(
    () => Array.from({ length: gridCount }, (_, i) => gridCount - i),
    [gridCount],
  );
  const previewIds = useMemo(() => {
    const out: number[] = [];
    for (let i = totalMinted + 1; i <= PREVIEW_CAP; i++) out.push(i);
    return out;
  }, [totalMinted]);

  // The first RARITY_CAP minted tokens (lowest ids), still newest-first.
  const cappedIds = useMemo(
    () => ids.filter((id) => id <= RARITY_CAP),
    [ids],
  );

  const rarityActive = filter !== "All" || sortByRarity;

  // Lazy rarity load: fires only on first activation of filter/sort, once.
  useEffect(() => {
    if (!rarityActive || rarity !== null || rarityLoading || !summary) return;

    const targets = cappedIds;
    let cancelled = false;
    setRarityLoading(true);

    const result = new Map<number, RarityInfo | null>();
    // Preview ids are computed locally — no RPC needed.
    for (const id of previewIds) {
      result.set(id, previewCardMeta(id));
    }
    let next = 0;

    async function worker() {
      while (!cancelled) {
        const index = next++;
        if (index >= targets.length) return;
        const id = targets[index];
        try {
          // Rarity is computed from the DISPLAY seed (post-inclusion entropy),
          // not the raw seedOf.
          const { displaySeed } = await readDisplaySeed(publicClient, BigInt(id));
          result.set(
            id,
            IS_V2 ? rarityForSeedV2(displaySeed) : rarityForSeed(displaySeed),
          );
        } catch {
          // Tolerate per-token failures silently: this id drops out of
          // tier-filtering and sorts to the end. No user-facing error.
          result.set(id, null);
        }
      }
    }

    Promise.all(
      Array.from(
        { length: Math.min(RARITY_CONCURRENCY, targets.length) },
        () => worker(),
      ),
    ).then(() => {
      if (!cancelled) {
        setRarity(result);
        setRarityLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [rarityActive, rarity, rarityLoading, summary, cappedIds, previewIds]);

  const rarityReady = rarity !== null;
  const showRarityView = rarityActive && rarityReady;

  // Default view = full grid ids (minted + preview cards), newest first (no
  // RPC beyond the summary reads). Rarity view = tier-filtered and/or sorted
  // by IC score; preview ids use their locally computed rarity.
  let displayIds = gridIds;
  if (showRarityView) {
    const base = gridIds;
    const filtered =
      filter === "All"
        ? base
        : base.filter((id) => rarity?.get(id)?.tier === filter);
    displayIds = sortByRarity
      ? [...filtered].sort((a, b) => {
          const scoreA = rarity?.get(a)?.score ?? Number.NEGATIVE_INFINITY;
          const scoreB = rarity?.get(b)?.score ?? Number.NEGATIVE_INFINITY;
          return scoreB - scoreA;
        })
      : filtered;
  }

  return (
    <main className="container">
      <span className="eyebrow">The collection</span>
      <h1>Proof of Architect</h1>
      <p className="muted">
        Proof-of-work minted collection on Arc. Every token is derived
        deterministically from its on-chain seed.
      </p>

      {summary && (
        <section className="stats-band" aria-label="Collection statistics">
          <div className="stat-grid">
            <div className="stat">
              <div className="label">Minted</div>
              <div className="value">
                {summary.totalMinted.toString()} /{" "}
                {summary.maxSupply.toString()}
              </div>
            </div>
            <div className="stat">
              <div className="label">Wave</div>
              <div className="value">{summary.wave.toString()}</div>
            </div>
            <div className="stat">
              <div className="label">Claims left</div>
              <div className="value">
                {summary.claimsLeft.toString()} /{" "}
                {summary.freeClaims.toString()}
              </div>
            </div>
            <div className="stat">
              <div className="label">Current price</div>
              <div className="value">
                {summary.price === 0n
                  ? "FREE"
                  : `${formatUsdc(summary.price)} USDC`}
              </div>
            </div>
          </div>
        </section>
      )}

      <LiveFeed />

      {summary && totalMinted > 0 && (
        <div className="rarity-toolbar">
          <div
            className="chip-row"
            role="group"
            aria-label="Filter by rarity tier"
          >
            {(["All", ...TIERS] as TierFilter[]).map((tier) => (
              <button
                key={tier}
                type="button"
                className={`chip${filter === tier ? " active" : ""}`}
                onClick={() => setFilter(tier)}
              >
                {tier}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`sort-toggle${sortByRarity ? " on" : ""}`}
            aria-pressed={sortByRarity}
            onClick={() => setSortByRarity((value) => !value)}
          >
            Sort by rarity{sortByRarity ? " · on" : ""}
          </button>
          <div className="small muted rarity-note">
            Rarity filter &amp; sort analyze the first {RARITY_CAP} minted tokens
            {totalMinted > RARITY_CAP ? ` of ${totalMinted}` : ""}; older tokens
            are not analyzed.
            {previewIds.length > 0 ? " Preview cards are computed locally." : ""}
          </div>
        </div>
      )}

      {loading && <div className="banner">Loading collection…</div>}

      {error && (
        <div className="banner error">
          Could not read the contract: {error}
          <div className="small muted" style={{ marginTop: 6 }}>
            RPC: {ARC_RPC_URL} · contract: {CONTRACT_ADDRESS}
          </div>
        </div>
      )}

      {rarityActive && rarityLoading && (
        <div className="banner">
          Analyzing rarity for {cappedIds.length} token
          {cappedIds.length === 1 ? "" : "s"}…
        </div>
      )}

      {summary && !error && ids.length === 0 && (
        <div className="banner">
          No tokens minted yet.{" "}
          <Link href="/mine">Be the first to mine one →</Link>
        </div>
      )}

      {showRarityView && displayIds.length === 0 && (
        <div className="banner">No tokens match this rarity filter.</div>
      )}

      {displayIds.length > 0 && (
        <div className="grid">
          {displayIds.map((id) => (
            <TokenCard
              key={id}
              id={id}
              tier={rarity?.get(id)?.tier}
              preview={id > totalMinted}
            />
          ))}
        </div>
      )}

      {/* Third proof teaser — HDD / DePIN season, not live yet (button is
          intentionally disabled). Placed after the collection, before the
          site footer. */}
      <section className="panel" aria-labelledby="hdd-season">
        <span className="eyebrow">The third proof</span>
        <h2 id="hdd-season" style={{ marginTop: 12 }}>
          The third proof: space
        </h2>
        <p className="muted">
          Season 2 introduces HDD (DePIN) mining — plot disks, farm them, mint
          from your drive.
        </p>

        <div
          className="chip-row"
          role="group"
          aria-label="The three proofs the project stands on"
        >
          <span className="chip active">1 · Work — live</span>
          <span className="chip active">2 · Stake — live</span>
          <span className="chip">3 · Space — Season 2</span>
        </div>

        <p className="muted">
          The current collection is CPU/GPU mined on proof of work. Next season
          your hard drive becomes the mining rig: proof of space — plot, farm,
          then mint from your drive. It is a separate season, not a change to
          the current collection.
        </p>

        <div className="chip-row" style={{ alignItems: "center", gap: 14 }}>
          <button
            type="button"
            className="button button-primary button-sm"
            disabled
            aria-disabled="true"
            title="HDD mining ships with Season 2"
          >
            HDD mining — Season 2
          </button>
          <Link
            href="https://proofofarchitect.gitbook.io/proof-of-architect/project/roadmap"
            className="small"
          >
            Season plan in the docs →
          </Link>
        </div>
      </section>
    </main>
  );
}
