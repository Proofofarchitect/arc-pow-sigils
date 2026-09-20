import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { SITE_URL } from "@/lib/site";
import { CONTRACT_ADDRESS } from "@/lib/contract";

export const metadata: Metadata = {
  title: "Stats dataset — Proof of Architect",
  description:
    "Machine-readable statistics for Proof of Architect: the JSON schema of /stats/current.json and /stats/history.jsonl, units, methodology and how to cite the data.",
};

const codeStyle: CSSProperties = {
  background: "var(--paper-blue)",
  border: "2px solid var(--ink)",
  borderRadius: 0,
  boxShadow: "4px 4px 0 rgba(17, 24, 43, 0.18)",
  padding: "12px 14px",
  overflowX: "auto",
  fontFamily: "var(--mono)",
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink)",
  margin: "10px 0 0",
  whiteSpace: "pre",
};

function Code({ children }: { children: string }) {
  return <pre style={codeStyle}>{children}</pre>;
}

type Endpoint = {
  label: string;
  href: string;
  note: string;
};

const ENDPOINTS: Endpoint[] = [
  {
    label: "/stats",
    href: `${SITE_URL}/stats`,
    note: "Human and agent readable HTML view (server-rendered, no JavaScript).",
  },
  {
    label: "/stats/current.json",
    href: `${SITE_URL}/stats/current.json`,
    note: "A single object — the latest live snapshot.",
  },
  {
    label: "/stats/history.jsonl",
    href: `${SITE_URL}/stats/history.jsonl`,
    note: "JSON Lines — one snapshot per line, append-only, chronological.",
  },
];

type Field = {
  key: string;
  type: string;
  units: string;
};

const CURRENT_FIELDS: Field[] = [
  { key: "domain", type: "string", units: "snapshot schema id: proofofarchitect.stats/1" },
  { key: "updatedAt", type: "string", units: "ISO-8601 UTC, time of the on-chain reads" },
  { key: "chainId", type: "integer", units: "5042002 (Arc)" },
  { key: "contract", type: "string", units: "0x address used for the reads" },
  { key: "site", type: "string", units: "canonical site URL" },
  { key: "wave", type: "integer", units: "1-based current wave" },
  {
    key: "priceUsdc",
    type: "string",
    units: 'current mint price as decimal USDC; "0" means free',
  },
  { key: "totalMinted", type: "integer", units: "cards minted (free + paid)" },
  { key: "maxSupply", type: "integer", units: "15,042" },
  { key: "freeClaims", type: "integer", units: "total free claim codes (42)" },
  { key: "claimsLeft", type: "integer", units: "unclaimed free claim codes" },
  { key: "mintPaused", type: "boolean", units: "mint pause flag" },
  { key: "baseBits", type: "integer", units: "bits (wave-1 base difficulty)" },
  {
    key: "currentRequiredBits",
    type: "integer",
    units: "bits (difficulty for a fresh wallet: no streak, no stake)",
  },
  {
    key: "stakingDiscountBits",
    type: "integer (optional)",
    units: "bits; v3.1 cores only, omitted on a v3 core",
  },
];

const HISTORY_FIELDS: Field[] = [
  { key: "ts", type: "string", units: "ISO-8601 UTC timestamp of the snapshot" },
  { key: "wave", type: "integer", units: "1-based wave" },
  { key: "totalMinted", type: "integer", units: "cards minted" },
  { key: "priceUsdc", type: "string", units: "decimal USDC price" },
  { key: "requiredBits", type: "integer", units: "bits (fresh-wallet difficulty)" },
  { key: "baseBits", type: "integer", units: "bits (wave-1 base)" },
];

function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <table className="tier-table" style={{ marginTop: 12 }}>
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Units / meaning</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key}>
            <td className="mono">{field.key}</td>
            <td className="mono small">{field.type}</td>
            <td className="small muted">{field.units}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function StatsDocsPage() {
  return (
    <main className="container">
      <p className="small">
        <Link href="/docs">← Docs</Link> · <Link href="/">Collection</Link>
      </p>
      <h1>Stats dataset</h1>
      <p className="muted">
        Proof of Architect publishes machine-readable statistics generated from
        live on-chain reads. The data is served as static, server-rendered
        resources that work without JavaScript or a wallet, so an agent can fetch
        and cite concrete numbers instead of scraping. Reference contract (Arc):
        <span className="mono">{CONTRACT_ADDRESS}</span>.
      </p>

      <div className="panel">
        <h2>1. Endpoints</h2>
        {ENDPOINTS.map((item) => (
          <div className="row" key={item.label}>
            <span className="k">
              <a href={item.href} className="mono">
                {item.label}
              </a>
            </span>
            <span className="v small" style={{ maxWidth: "60%" }}>
              {item.note}
            </span>
          </div>
        ))}
        <p className="muted small" style={{ marginBottom: 0 }}>
          The HTML page at <span className="mono">/stats</span> is the human view
          (it also carries a <span className="mono">schema.org/Dataset</span>
          {" "}JSON-LD block); the two JSON resources are the machine contract
          described below.
        </p>
      </div>

      <div className="panel">
        <h2>2. /stats/current.json</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A single JSON object: the most recent snapshot, a direct read of the
          contract. Example (values illustrative):
        </p>
        <Code>{`{
  "domain": "proofofarchitect.stats/1",
  "updatedAt": "2026-09-16T21:08:56.181Z",
  "chainId": 5042002,
  "contract": "0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b",
  "site": "${SITE_URL}",
  "wave": 1,
  "priceUsdc": "1",
  "totalMinted": 1,
  "maxSupply": 15042,
  "freeClaims": 42,
  "claimsLeft": 42,
  "mintPaused": false,
  "baseBits": 30,
  "currentRequiredBits": 30
}`}</Code>
        <FieldTable fields={CURRENT_FIELDS} />
        <p className="muted small">
          Units in one line: USDC is the native Arc gas token with 18 decimals, so
          the underlying on-chain price is a <span className="mono">uint256</span>{" "}
          in wei (1 USDC = 1e18); the snapshot exposes it already scaled as a
          decimal string in <span className="mono">priceUsdc</span> (
          <span className="mono">"0"</span> means free). All{" "}
          <span className="mono">*Bits</span> fields are leading-zero-bit
          difficulties.{" "}
          <span className="mono">stakingDiscountBits</span> is read from the staking
          module and is present on the current deployment.
        </p>
      </div>

      <div className="panel">
        <h2>3. /stats/history.jsonl</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A JSON Lines file: one compact JSON object per line, no surrounding
          array, no commas between lines. Each line is a lightweight snapshot (a
          subset of <span className="mono">current.json</span>, with{" "}
          <span className="mono">ts</span> instead of{" "}
          <span className="mono">updatedAt</span>), appended oldest first:
        </p>
        <Code>{`{"ts":"2026-09-16T17:00:00.000Z","wave":1,"totalMinted":1,"priceUsdc":"1","requiredBits":30,"baseBits":30}
{"ts":"2026-09-16T19:00:00.000Z","wave":1,"totalMinted":1,"priceUsdc":"1","requiredBits":30,"baseBits":30}
{"ts":"2026-09-16T21:08:56.181Z","wave":1,"totalMinted":1,"priceUsdc":"1","requiredBits":30,"baseBits":30}`}</Code>
        <FieldTable fields={HISTORY_FIELDS} />
        <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Append-only and chronological (oldest first); the last line is the
            most recent recorded state.
          </li>
          <li>
            Parse line by line (streaming); ignore blank lines. Do not assume a
            key exists in every line — the shape is a stable subset and may grow
            additively.
          </li>
          <li>
            The line count equals the number of recorded changes, not the number
            of mints (see the cadence note below).
          </li>
        </ul>
      </div>

      <div className="panel">
        <h2>4. Methodology</h2>
        <ul className="small" style={{ marginTop: 0, paddingLeft: 20 }}>
          <li>
            <strong>Source.</strong> Every value is read directly from the deployed
            contract on Arc over RPC via viem (
            <span className="mono">eth_call</span>). There is no indexer and no
            database behind the numbers.
          </li>
          <li>
            <strong>Reads.</strong> Collection views (
            <span className="mono">
              totalMinted, maxSupply, freeClaims, claimsLeft, currentWave, currentPrice, baseBits, mintPaused
            </span>
            ) plus <span className="mono">requiredBits(0x0)</span> for{" "}
            <span className="mono">currentRequiredBits</span>.{" "}
            <span className="mono">stakingDiscountBits(0x0)</span> is added when
            a staking module is wired and omitted otherwise.
          </li>
          <li>
            <strong>Cache and freshness.</strong> <span className="mono">current.json</span>{" "}
            is generated with a short cache (about 60 seconds;{" "}
            <span className="mono">s-maxage=60, stale-while-revalidate=300</span>)
            and always carries <span className="mono">updatedAt</span>, the
            timestamp of the reads. Treat <span className="mono">updatedAt</span>{" "}
            as authoritative and do not cache the file in a consumer for longer
            than that.
          </li>
          <li>
            <strong>History.</strong> <span className="mono">history.jsonl</span> is
            served from a repo-seeded file and appended by a small ops cron that
            polls <span className="mono">current.json</span> and writes a new line
            only when the values change (with a one-hour dedup window while the
            chain is quiet).
          </li>
          <li>
            <strong>Determinism.</strong> Rarity and difficulty are recomputed from
            on-chain state; the exact math is documented on{" "}
            <Link href="/docs/verification">/docs/verification</Link>.
          </li>
        </ul>
      </div>

      <div className="panel">
        <h2>5. How to cite</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Quote the URL, the dataset id and the <span className="mono">updatedAt</span>{" "}
          timestamp so the number is reproducible:
        </p>
        <Code>{`Proof of Architect stats — chainId 5042002, contract 0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b,
dataset proofofarchitect.stats/1, ${SITE_URL}/stats/current.json, updatedAt <ISO-8601 UTC>.`}</Code>
        <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 20 }}>
          <li>
            For difficulty, quote <span className="mono">baseBits</span> and{" "}
            <span className="mono">currentRequiredBits</span> in{" "}
            <strong>bits</strong>.
          </li>
          <li>
            For price, quote <span className="mono">priceUsdc</span> and say it is
            native USDC (18 decimals).
          </li>
          <li>
            For supply, quote <span className="mono">totalMinted</span> /{" "}
            <span className="mono">maxSupply</span> and{" "}
            <span className="mono">claimsLeft</span> /{" "}
            <span className="mono">freeClaims</span>.
          </li>
        </ul>
      </div>

      <div className="panel">
        <h2>6. Cadence and versioning</h2>
        <ul className="small" style={{ marginTop: 0, paddingLeft: 20 }}>
          <li>
            <span className="mono">current.json</span>: refreshed continuously with
            a cache of about 60 seconds.
          </li>
          <li>
            <span className="mono">history.jsonl</span>: one new line per change
            (a mint, a wave or price change, pause/unpause), appended by the ops
            cron with a one-hour dedup window.
          </li>
          <li>
            <strong>Versioning.</strong> The schema is versioned by{" "}
            <span className="mono">domain</span> (
            <span className="mono">proofofarchitect.stats/1</span>); new keys are
            added in a backward-compatible way and a breaking change bumps the
            suffix. Optional expansions (for example a flat CSV mirror and richer
            rarity coverage) are planned and would be added additively.
          </li>
        </ul>
      </div>

      <p className="small muted" style={{ marginTop: 18 }}>
        Related: <Link href="/docs/agent-access">Agent access</Link> ·{" "}
        <Link href="/docs/verification">Verification</Link> ·{" "}
        <Link href="/stats">Live stats</Link> · <Link href="/docs">Docs index</Link>{" "}
        ·{" "}
        <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
          GitBook
        </a>
      </p>
    </main>
  );
}
