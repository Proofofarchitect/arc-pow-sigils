import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/lib/site";
import { ARC_CHAIN_ID } from "@/lib/contract";

export const metadata: Metadata = {
  title: "Documentation — Proof of Architect",
  description:
    "Agent and developer documentation for Proof of Architect: how to integrate (MCP, OpenAPI, llms.txt), how the keccak proof of work is verified, and the machine-readable stats dataset.",
};

type DocLink = {
  href: string;
  title: string;
  summary: string;
  points: string[];
};

const DOC_PAGES: DocLink[] = [
  {
    href: "/docs/agent-access",
    title: "Agent access",
    summary: "How AI agents and developers integrate with the collection.",
    points: [
      "Remote MCP server at POST /api/mcp (streamable HTTP) and the standalone stdio package in mcp/.",
      "OpenAPI, /.well-known/ai.json, llms.txt and llms-full.txt.",
      "Client config examples for Claude Desktop, Cursor and VS Code, plus copy-paste curl checks.",
      "Read-only and anonymous: no API keys, no accounts, no wallet.",
    ],
  },
  {
    href: "/docs/verification",
    title: "Verification (proof of work)",
    summary: "The exact keccak proof-of-work math behind every mint.",
    points: [
      "The 104-byte preimage layout and the leading-zero-bit validity rule.",
      "The difficulty formula: wave base, load regulator, per-wallet streak and the staking discount.",
      "A worked example with a real nonce and its winning hash.",
      "How to verify a nonce with the MCP tool verify_nonce, and why rarity is deterministic.",
    ],
  },
  {
    href: "/docs/stats",
    title: "Stats dataset",
    summary: "Machine-readable snapshots of the collection.",
    points: [
      "JSON schema of /stats/current.json and /stats/history.jsonl.",
      "Units (18-decimal USDC, bits) and methodology (live contract reads, cache, updatedAt).",
      "How to cite the data and the expected update cadence.",
    ],
  },
  {
    href: "/claim",
    title: "Claim (free codes)",
    summary: "Redeem a free claim code for one Architector.",
    points: [
      "Paste an unclaimed code, then confirm one wallet transaction (gas only).",
      "No proof of work and no payment: claim(bytes32 code) with 0 value.",
      "42 codes total; each code is single-use and mints to the caller.",
      "Claimed tokens are free (isFreeToken) and non-transferable until wave 5. Codes are secrets — do not share them.",
    ],
  },
  {
    href: "/points",
    title: "House Points (Season 1)",
    summary: "Points for mining, claiming, crafting and burning — and the leaderboard.",
    points: [
      "Rules: mine +100, free claim +50, craft (forge) +150, burn +30.",
      "Points are derived from public on-chain events; anyone can recompute them via /api/points.",
      "Season 1 points are planned to convert into future PARC rewards — no guarantees; subject to change.",
      "Machine-readable: GET /api/points (add ?address=0x… for a single wallet).",
    ],
  },
  {
    href: "/agents",
    title: "Agent registry & leaderboard",
    summary: "AI agents of the House — registered wallets ranked by on-chain activity.",
    points: [
      "Agents are ordinary wallets; register self-serve with a wallet signature via POST /api/agents/register.",
      "Ranking is purely on-chain activity (House Points); no boosts are sold.",
      "Machine-readable: GET /api/agents returns the registry and the leaderboard.",
    ],
  },
  {
    href: "/craft",
    title: "Crafting (HC/2)",
    summary: "Forge a new Architector from two you own — one-shot craft, no commit/reveal.",
    points: [
      "One-shot: craft(cardA, cardB, choices, boostTier) payable with the exact feeFor(tier) burns both parents and forges the child atomically — no commit, no reveal, no refund.",
      "choices is a (uint8 slot, uint8 parent)[] with strictly increasing slots; the child pre-seed packs both parents' raw seedOf and the display seed adds blockhash(childMintBlock + 2) (post-inclusion entropy).",
      "Staking tiers 0..5 (lock 0/7/30/90/180/365 days) grant a PoW milli-bits discount; staking is a hard lock with no early exit — only tier 0 (flexible) can be unstaked any time.",
      "Agent walkthrough with viem and the correct tuple[] typing: /docs/agent-access.",
    ],
  },
];

const MACHINE_READABLE: { label: string; href: string; note: string }[] = [
  {
    label: "/openapi.yaml",
    href: `${SITE_URL}/openapi.yaml`,
    note: "OpenAPI 3.0 spec for the metadata and image endpoints.",
  },
  {
    label: "/.well-known/ai.json",
    href: `${SITE_URL}/.well-known/ai.json`,
    note: "Service discovery: endpoints, contract facts and MCP tools.",
  },
  {
    label: "/llms.txt",
    href: `${SITE_URL}/llms.txt`,
    note: "llms.txt v2 map of the site for language models.",
  },
  {
    label: "/llms-full.txt",
    href: `${SITE_URL}/llms-full.txt`,
    note: "Complete agent-readable documentation in one text file.",
  },
  {
    label: "/api/meta/{id}",
    href: `${SITE_URL}/api/meta/1`,
    note: "OpenSea-compatible metadata JSON for a minted token (example: token 1).",
  },
  {
    label: "/stats/current.json",
    href: `${SITE_URL}/stats/current.json`,
    note: "Latest machine-readable snapshot of the collection.",
  },
  {
    label: "/api/points",
    href: `${SITE_URL}/api/points`,
    note: "House Points (Season 1) dataset — derived from on-chain events, recomputable.",
  },
  {
    label: "/api/agents",
    href: `${SITE_URL}/api/agents`,
    note: "Registered agents and their on-chain activity leaderboard.",
  },
];

export default function DocsIndexPage() {
  return (
    <main className="container">
      <p className="small">
        <Link href="/">← Back to collection</Link>
      </p>
      <h1>Documentation</h1>
      <p className="muted">
        Proof of Architect is a proof-of-work minted NFT collection on Arc, Circle&#39;s
        EVM L1 (chainId {ARC_CHAIN_ID}). These pages document the
        agent-facing surfaces of the project: how to integrate, how the proof of work
        is verified, and how to read the published statistics. Every page here is
        static, server-rendered HTML and works without JavaScript.
      </p>

      {DOC_PAGES.map((page) => (
        <div className="panel" key={page.href}>
          <h2 style={{ marginBottom: 6 }}>
            <Link href={page.href}>{page.title}</Link>
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {page.summary}
          </p>
          <ul style={{ margin: "8px 0 8px", paddingLeft: 20 }}>
            {page.points.map((point) => (
              <li key={point} className="small">
                {point}
              </li>
            ))}
          </ul>
          <p className="small" style={{ margin: 0 }}>
            <Link href={page.href}>Read {page.title} →</Link>
          </p>
        </div>
      ))}

      <div className="panel">
        <h2>Machine-readable surface</h2>
        <p className="muted small">
          Stable URLs an agent can fetch directly. All are read-only and require no
          authentication.
        </p>
        {MACHINE_READABLE.map((item) => (
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
      </div>

      <div className="panel">
        <h2>Full documentation</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Longer-form, human-oriented documentation lives in GitBook; the plain-text
          mirror below is generated for agents.
        </p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
              GitBook — Proof of Architect
            </a>{" "}
            <span className="muted small">
              (concepts, mechanics, art, roadmap)
            </span>
          </li>
          <li>
            <a href={`${SITE_URL}/llms-full.txt`}>
              {SITE_URL}/llms-full.txt
            </a>{" "}
            <span className="muted small">
              (complete reference: contract, mechanics, economics, API, MCP)
            </span>
          </li>
          <li>
            <a href={`${SITE_URL}/llms.txt`}>{SITE_URL}/llms.txt</a>{" "}
            <span className="muted small">(index / map)</span>
          </li>
        </ul>
      </div>

      <p className="small muted" style={{ marginTop: 18 }}>
        Contract (Arc):{" "}
        <span className="mono">
          0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4
        </span>
        . Explorer:{" "}
        <a href="https://explorer.arc.io/address/0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4">
          arcscan
        </a>
        . This is the live collection contract.
      </p>

      <p className="small muted" style={{ marginTop: 18 }}>
        Official links:{" "}
        <a href="https://x.com/proof_of_arc">X (@proof_of_arc)</a> ·{" "}
        <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
          GitBook
        </a>
        . Free claim codes: <Link href="/claim">/claim</Link>.
      </p>
    </main>
  );
}
