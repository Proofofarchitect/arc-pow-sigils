"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { createPublicClient, http, type Address } from "viem";
import { arcTestnet, ARC_RPC_URL, explorerUrl } from "@/lib/arc";
import { rpcFetch } from "@/lib/rpc";
import { CONTRACT_ADDRESS, POW_MINT_NFT_ABI } from "@/lib/contract";
import {
  attributeMap,
  deriveAttributes,
  type DerivedAttributes,
} from "@/lib/traits";
import { deriveAttributesV2 } from "@/lib/traits_v2";
import { IS_V2, TRAITS_IMAGE_QS } from "@/lib/traits-set";
import {
  informationContent,
  rarityPercentile,
  slotContributions,
  tierForScore,
  type RarityTier,
} from "@/lib/rarity";
import {
  informationContentV2,
  rarityPercentileV2,
  slotContributionsV2,
  tierForScoreV2,
} from "@/lib/rarity_v2";
import { computeWork } from "@/lib/pow";
import {
  derivePreviewAttributes,
  isPreviewId,
  previewSeed,
} from "@/lib/preview";

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() }),
});

/**
 * Forged/crafted token ids live at ≥ 10_000_000 (mirrors `FORGE_ID_BASE` in
 * `lib/hc2chain.ts` / the core contract). Kept local so this client component
 * does not bundle the server-side HC/2 log scanner.
 */
const FORGE_ID_BASE = 10_000_000n;

type TokenData = {
  owner: Address;
  seed: `0x${string}`;
  nonce: bigint;
  tokenURI: string;
};

/** Shape returned by `/api/meta/[id]` (only the fields this page consumes). */
type MetaResponse = {
  attributes: { trait_type: string; value: string }[];
  rarity?: { score: number; tier: RarityTier };
  crafted?: boolean;
  craftedLookup?: "ok" | "unavailable";
};

const SLOT_LABELS: Record<string, string> = {
  background: "Background",
  body: "Body",
  head: "Head",
  outfit: "Outfit",
  hair: "Hair",
  face: "Face",
  eyes: "Eyes",
  nose: "Nose",
  mouth: "Mouth",
  eyewear: "Eyewear",
  headwear: "Headwear",
  era: "Era",
  origin: "Origin",
  quote: "Quote",
  lore: "Lore",
  tool: "Tool",
  companion: "Companion",
  legendary: "Legendary",
  golden: "Golden",
  bug: "Bug",
};

export default function TokenPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  // Crafted ids (≥ FORGE_ID_BASE) get their traits from HC/2, resolved
  // server-side by /api/meta (client-side event scanning would be far too heavy).
  const crafted = /^\d+$/.test(id) && BigInt(id) >= FORGE_ID_BASE;

  const [data, setData] = useState<TokenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [imgFailed, setImgFailed] = useState(false);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  // For crafted ids only: fetch the server-resolved HC/2 traits + rarity.
  useEffect(() => {
    if (!crafted) return;
    let cancelled = false;
    setMetaError(null);
    fetch(`/api/meta/${id}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<MetaResponse>;
      })
      .then((json) => {
        if (!cancelled) setMeta(json);
      })
      .catch((e) => {
        if (!cancelled) {
          setMetaError(e instanceof Error ? e.message : "Failed to load traits");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, crafted]);

  useEffect(() => {
    if (!/^\d+$/.test(id)) {
      setError("Token id must be an unsigned integer.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const tokenId = BigInt(id);

    async function load() {
      try {
        const [owner, seed, nonce, tokenURI] = await Promise.all([
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "ownerOf",
            args: [tokenId],
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "seedOf",
            args: [tokenId],
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "nonceOf",
            args: [tokenId],
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: POW_MINT_NFT_ABI,
            functionName: "tokenURI",
            args: [tokenId],
          }),
        ]);
        if (!cancelled) setData({ owner, seed, nonce, tokenURI });
      } catch (e) {
        if (!cancelled) {
          if (isPreviewId(tokenId)) {
            // Preview window: not minted yet — render from the deterministic
            // preview seed instead of erroring (testnet / pre-launch mode).
            setPreview(true);
          } else {
            setError(
              e instanceof Error
                ? e.message.includes("revert") ||
                  /owner|exist|minted/i.test(e.message)
                  ? "This token has not been minted yet."
                  : e.message
                : "Failed to load token",
            );
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Primary image source: our deterministic renderer. If the contract tokenURI
  // has been re-pointed to this deployment it resolves to the same asset; the
  // local route is a reliable fallback while baseURI still points elsewhere.
  const imageSrc = `/api/image/${id}${TRAITS_IMAGE_QS}`;

  // Full House Card trait set. Normal ids derive client-side from the on-chain
  // seed; crafted ids (≥ 10M) use the server-resolved HC/2 traits from
  // /api/meta (their traits are NOT a plain function of the seed).
  const derived: DerivedAttributes | null = crafted
    ? meta
      ? {
          attributes: meta.attributes
            .filter((attribute) => attribute.trait_type !== "Golden")
            .map((attribute) => ({
              slot: attribute.trait_type,
              value: attribute.value,
            })),
          golden: meta.attributes.some(
            (attribute) => attribute.trait_type === "Golden",
          ),
        }
      : null
    : data
      ? IS_V2
        ? deriveAttributesV2(data.seed)
        : deriveAttributes(data.seed)
      : preview
        ? derivePreviewAttributes(BigInt(id))
        : null;
  const goldenEvent = derived?.golden
    ? derived.attributes.find((attribute) => attribute.slot === "golden")?.value
    : null;
  const work = data ? computeWork(data.owner, data.nonce) : null;

  // Rarity (rarity/1), computed from the SAME attributes as the traits panel.
  // For crafted ids the score/tier come from the server (HC/2 attributes); for
  // normal ids they derive locally — no additional RPC either way.
  const rarity = derived
    ? (() => {
        const attrs = attributeMap(derived);
        const score =
          crafted && meta?.rarity
            ? meta.rarity.score
            : IS_V2
              ? informationContentV2(attrs)
              : informationContent(attrs);
        const tier =
          crafted && meta?.rarity
            ? meta.rarity.tier
            : IS_V2
              ? tierForScoreV2(score)
              : tierForScore(score);
        const percentile = IS_V2
          ? rarityPercentileV2(score)
          : rarityPercentile(score);
        const contributions = (IS_V2
          ? slotContributionsV2(attrs)
          : slotContributions(attrs)
        )
          .map((contribution) => ({
            ...contribution,
            value: attrs[contribution.slot],
          }))
          .sort((a, b) => b.bits - a.bits)
          .slice(0, 3);
        return { score, tier, percentile, contributions };
      })()
    : null;

  return (
    <main className="container">
      <p className="small">
        <Link href="/">← Back to collection</Link>
      </p>

      {loading && <div className="banner">Loading token…</div>}
      {error && <div className="banner error">{error}</div>}
      {crafted && metaError && (
        <div className="banner error">
          Could not load crafted traits ({metaError}).
        </div>
      )}
      {crafted && meta?.craftedLookup === "unavailable" && (
        <div className="banner warn">
          HC/2 lookup unavailable — showing a fallback derivation of the child
          seed, not the crafted traits. Traits/rarity here may not match the
          minted card.
        </div>
      )}

      {(data || preview) && (
        <div className="two-col" style={{ marginTop: 18 }}>
          <div className="nft-visual">
            <div className="nft-stage">
              {imgFailed ? (
                <div className="banner warn">
                  Image unavailable. The contract tokenURI or the renderer could
                  not produce an image for this token.
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="token-image"
                  src={imageSrc}
                  alt={`Proof of Architect #${id}`}
                  onError={() => setImgFailed(true)}
                />
              )}
            </div>
            <div className="artifact-caption">
              <span>Rendered from seed</span>
              <span>
                {IS_V2 ? "1254 × 1254" : "1024 × 1024"} / deterministic PNG
              </span>
            </div>
          </div>

          <div>
            <header className="nft-header">
              <span className="eyebrow">Architector registry entry</span>
              <h1>Architector #{String(id).padStart(4, "0")}</h1>
              {data && (
                <p className="owner-line">
                  Owner{" "}
                  <a
                    href={explorerUrl(`address/${data.owner}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {data.owner}
                  </a>
                </p>
              )}
              {(preview || crafted || derived?.golden) && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    marginTop: 14,
                  }}
                >
                  {preview && (
                    <span className="badge badge-preview">
                      Preview — not minted
                    </span>
                  )}
                  {crafted && (
                    <span className="badge badge-crafted">Crafted card</span>
                  )}
                  {derived?.golden && (
                    <span className="badge badge-golden">
                      Golden · {goldenEvent}
                    </span>
                  )}
                </div>
              )}
            </header>

            {rarity && (
              <>
                <div className="panel-heading">
                  <h2>Rarity</h2>
                  <span>
                    Information content · {IS_V2 ? "rarity/2" : "rarity/1"}
                  </span>
                </div>
                <div className="panel" style={{ marginTop: 0 }}>
                  <div className="rarity-head">
                    <span className={`badge tier-${rarity.tier.toLowerCase()}`}>
                      {rarity.tier}
                    </span>
                    <span className="rarity-score">
                      {rarity.score.toFixed(2)}
                      <span className="muted small"> bits</span>
                    </span>
                    <span className="rarity-top">
                      Top {(100 - rarity.percentile).toFixed(1)}%
                    </span>
                  </div>
                  <div className="small muted" style={{ marginTop: 6 }}>
                    Higher bits = rarer. Percentile over the full trait
                    distribution.
                  </div>

                  <div className="rarity-contrib-head">
                    Top contributing slots
                  </div>
                  {rarity.contributions.map((contribution) => (
                    <div className="row" key={contribution.slot}>
                      <span className="k">
                        {SLOT_LABELS[contribution.slot] ?? contribution.slot} ·{" "}
                        {contribution.value}
                      </span>
                      <span className="v">
                        {contribution.bits.toFixed(2)} bits
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {derived && (
              <>
                <div className="panel-heading">
                  <h2>Deterministic traits</h2>
                  <span>
                    {
                      derived.attributes.filter(
                        (attribute) => attribute.slot !== "golden",
                      ).length
                    }{" "}
                    slots · {IS_V2 ? "arc-traits/2" : "house-card/1"}
                  </span>
                </div>
                <dl className="trait-list">
                  {derived.attributes
                    .filter((attribute) => attribute.slot !== "golden")
                    .map((attribute) => (
                      <div
                        className={`trait${
                          attribute.slot === "legendary" &&
                          attribute.value !== "None"
                            ? " special"
                            : ""
                        }`}
                        key={attribute.slot}
                      >
                        <dt>{SLOT_LABELS[attribute.slot] ?? attribute.slot}</dt>
                        <dd>{attribute.value}</dd>
                      </div>
                    ))}
                  {!IS_V2 && (
                    <div className={`trait${derived.golden ? " special" : ""}`}>
                      <dt>Golden</dt>
                      <dd>{derived.golden ? (goldenEvent ?? "Yes") : "No"}</dd>
                    </div>
                  )}
                </dl>
              </>
            )}

            <section className="onchain" aria-label="On-chain proof">
              <div className="onchain-head">
                <h3>On-chain proof</h3>
                <span>
                  {preview ? "Preview — not minted" : "Read from Arc"}
                </span>
              </div>
              {data ? (
                <dl className="chain-data">
                  <div className="chain-item">
                    <dt>Token ID</dt>
                    <dd>#{id}</dd>
                  </div>
                  <div className="chain-item">
                    <dt>Nonce</dt>
                    <dd>{data.nonce.toString()}</dd>
                  </div>
                  <div className="chain-item">
                    <dt>Seed (seedOf)</dt>
                    <dd>{data.seed}</dd>
                  </div>
                  {work && (
                    <div className="chain-item">
                      <dt>Work (workFor)</dt>
                      <dd>{work}</dd>
                    </div>
                  )}
                  <div className="chain-item">
                    <dt>Owner</dt>
                    <dd>{data.owner}</dd>
                  </div>
                  <div className="chain-item">
                    <dt>tokenURI</dt>
                    <dd>{data.tokenURI}</dd>
                  </div>
                </dl>
              ) : (
                <dl className="chain-data">
                  <div className="chain-item">
                    <dt>Preview seed</dt>
                    <dd>{previewSeed(BigInt(id))}</dd>
                  </div>
                  <div className="chain-item">
                    <dt>Status</dt>
                    <dd>not minted — deterministic preview card</dd>
                  </div>
                </dl>
              )}
              <div className="verify-row">
                <span>
                  {preview
                    ? "Mine any new token to replace previews with real on-chain cards."
                    : "Metadata and image derived entirely from the recorded seed."}
                </span>
                {data && (
                  <a
                    href={explorerUrl(`token/${id}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Arc explorer →
                  </a>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </main>
  );
}
