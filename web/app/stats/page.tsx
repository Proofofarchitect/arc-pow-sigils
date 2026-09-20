import Link from "next/link";
import {
  getStatsSnapshot,
  STATS_DOMAIN,
  type StatsSnapshot,
} from "@/lib/stats";
import { SITE_URL } from "@/lib/site";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS } from "@/lib/contract";
import { explorerUrl } from "@/lib/arc";

/**
 * /stats — server-rendered, citable collection statistics (AI-discovery D1).
 *
 * Renders the live snapshot as plain HTML (no client JS, no wallet gate) plus a
 * schema.org/Dataset JSON-LD block so search engines and agents can consume the
 * dataset directly. Data is a live read of the contract via viem; see
 * /stats/current.json and /stats/history.jsonl for machine-readable forms.
 */
export const dynamic = "force-dynamic";

const CURRENT_JSON = `${SITE_URL}/stats/current.json`;
const HISTORY_JSONL = `${SITE_URL}/stats/history.jsonl`;
const LLMS_FULL = `${SITE_URL}/llms-full.txt`;

// Contracts are MIT-licensed; the published dataset is released under the same terms.
const LICENSE_URL = "https://opensource.org/license/mit";

function priceLabel(priceUsdc: string): string {
  return priceUsdc === "0" ? "FREE" : `${priceUsdc} USDC`;
}

function buildDatasetJsonLd(snapshot: StatsSnapshot | null) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Proof of Architect — collection statistics",
    description:
      "Live, verifiable stats for the Proof of Architect proof-of-work NFT " +
      "collection on Arc (ChainID 5042002): wave, price, supply, " +
      "free claims, difficulty bits and mint status, read directly from the " +
      "on-chain contract. Snapshot as JSON plus an append-only JSON Lines history.",
    url: `${SITE_URL}/stats`,
    identifier: STATS_DOMAIN,
    creator: {
      "@type": "Organization",
      name: "Proof of Architect",
      url: SITE_URL,
    },
    license: LICENSE_URL,
    isAccessibleForFree: true,
    keywords: [
      "proof of work",
      "PoW NFT",
      "Arc network",
      "NFT statistics",
      "keccak256 difficulty",
      "on-chain data",
      "Proof of Architect",
    ],
    variableMeasured: [
      "chainId",
      "wave",
      "priceUsdc",
      "totalMinted",
      "maxSupply",
      "freeClaims",
      "claimsLeft",
      "mintPaused",
      "baseBits",
      "currentRequiredBits",
    ],
    ...(snapshot ? { dateModified: snapshot.updatedAt } : {}),
    distribution: [
      {
        "@type": "DataDownload",
        name: "Current snapshot (JSON)",
        encodingFormat: "application/json",
        contentUrl: CURRENT_JSON,
      },
      {
        "@type": "DataDownload",
        name: "Snapshot history (JSON Lines)",
        encodingFormat: "application/x-ndjson",
        contentUrl: HISTORY_JSONL,
      },
    ],
  };
}

export default async function StatsPage() {
  let snapshot: StatsSnapshot | null = null;
  let error: string | null = null;

  try {
    snapshot = await getStatsSnapshot();
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  const jsonLd = buildDatasetJsonLd(snapshot);

  const rows: Array<{ k: string; v: string }> = snapshot
    ? [
        { k: "Wave", v: String(snapshot.wave) },
        { k: "Current price", v: priceLabel(snapshot.priceUsdc) },
        { k: "Total minted", v: `${snapshot.totalMinted} / ${snapshot.maxSupply}` },
        { k: "Free claims left", v: `${snapshot.claimsLeft} / ${snapshot.freeClaims}` },
        { k: "Mint paused", v: snapshot.mintPaused ? "yes" : "no" },
        { k: "Base difficulty", v: `${snapshot.baseBits} bits` },
        {
          k: "Fresh-wallet difficulty",
          v: `${snapshot.currentRequiredBits} bits`,
        },
        ...(snapshot.stakingDiscountBits !== undefined
          ? [{ k: "Staking discount", v: `${snapshot.stakingDiscountBits} bits` }]
          : []),
        { k: "Chain ID", v: String(snapshot.chainId) },
        { k: "Contract", v: snapshot.contract },
        { k: "Updated (UTC)", v: snapshot.updatedAt },
      ]
    : [];

  return (
    <main className="container">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <h1>Collection stats</h1>
      <p className="muted">
        Live, verifiable statistics for the Proof of Architect proof-of-work NFT
        collection. Every number is read directly from the on-chain contract — no
        server-side modelling, no wallet required.
      </p>

      {error && (
        <div className="banner error">
          Could not read the contract right now: {error}
          <div className="small muted" style={{ marginTop: 6 }}>
            The dataset is still available in machine-readable form below.
          </div>
        </div>
      )}

      {snapshot && (
        <>
          <div className="stat-grid" style={{ marginTop: 18 }}>
            <div className="stat">
              <div className="label">Wave</div>
              <div className="value">{snapshot.wave}</div>
            </div>
            <div className="stat">
              <div className="label">Minted</div>
              <div className="value">
                {snapshot.totalMinted} / {snapshot.maxSupply}
              </div>
            </div>
            <div className="stat">
              <div className="label">Price</div>
              <div className="value">{priceLabel(snapshot.priceUsdc)}</div>
            </div>
            <div className="stat">
              <div className="label">Fresh-wallet difficulty</div>
              <div className="value">{snapshot.currentRequiredBits} bits</div>
            </div>
          </div>

          <div className="panel">
            <h2>Snapshot</h2>
            <table className="tier-table">
              <tbody>
                {rows.map((row) => (
                  <tr key={row.k}>
                    <th scope="row">{row.k}</th>
                    <td className="mono">{row.v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="panel">
        <h2>Methodology</h2>
        <div className="row">
          <span className="k">Chain</span>
          <span className="v">Arc · chainId {ARC_CHAIN_ID}</span>
        </div>
        <div className="row">
          <span className="k">Contract</span>
          <span className="v">
            <a href={explorerUrl(`address/${CONTRACT_ADDRESS}`)}>{CONTRACT_ADDRESS}</a>
          </span>
        </div>
        <div className="row">
          <span className="k">Method</span>
          <span className="v">
            live on-chain reads via a viem public client
          </span>
        </div>
        <div className="row">
          <span className="k">Cache</span>
          <span className="v">60 s (s-maxage=60, stale-while-revalidate=300)</span>
        </div>
        <div className="row">
          <span className="k">Formulas</span>
          <span className="v">
            deterministic — see <Link href="/docs/verification">/docs/verification</Link>
          </span>
        </div>
        <div className="row">
          <span className="k">Snapshot id</span>
          <span className="v">{STATS_DOMAIN}</span>
        </div>
      </div>

      <div className="panel">
        <h2>Machine-readable data</h2>
        <ul>
          <li>
            <Link href="/stats/current.json">/stats/current.json</Link> — the
            current snapshot as JSON.
          </li>
          <li>
            <Link href="/stats/history.jsonl">/stats/history.jsonl</Link> —
            append-only snapshot history (JSON Lines).
          </li>
          <li>
            <Link href="/llms-full.txt">/llms-full.txt</Link> — full
            agent-readable documentation.
          </li>
          <li>
            <Link href="/docs/stats">/docs/stats</Link> — dataset methodology and
            field dictionary.
          </li>
        </ul>
      </div>
    </main>
  );
}
