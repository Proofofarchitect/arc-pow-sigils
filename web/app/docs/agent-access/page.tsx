import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { SITE_URL } from "@/lib/site";
import { CONTRACT_ADDRESS } from "@/lib/contract";
import { CRAFT_ADDRESS } from "@/lib/craft";
import { VAULT_ADDRESS } from "@/lib/staking";

export const metadata: Metadata = {
  title: "Agent access — Proof of Architect",
  description:
    "How AI agents and developers integrate with Proof of Architect: the remote MCP server at POST /api/mcp, the standalone stdio MCP package, OpenAPI, .well-known/ai.json and llms.txt.",
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

type Tool = {
  name: string;
  args: string;
  returns: string;
};

const TOOLS: Tool[] = [
  {
    name: "collection_stats",
    args: "—",
    returns:
      "totalMinted, maxSupply (15,042), freeClaims, claimsLeft, currentWave, currentPriceUSDC, mintPaused, baseBits, contract, chainId",
  },
  {
    name: "get_token",
    args: "tokenId",
    returns: "owner, seed, nonce, tokenURI, imageUrl, metadataUrl",
  },
  {
    name: "required_bits",
    args: "miner",
    returns: "requiredBits (current difficulty in leading zero bits) + formula",
  },
  {
    name: "verify_nonce",
    args: "miner, nonce",
    returns:
      "work, leadingZeroBits, requiredBits, valid — verifies a nonce without a transaction",
  },
  {
    name: "price_info",
    args: "—",
    returns:
      "wave, epochIndex, currentPriceUSDC and the full pricing schedule (1.0 USDC × 2 per wave, no cap)",
  },
  {
    name: "verify_rarity",
    args: "tokenId",
    returns: "score (bits), tier, golden, legendary — from the on-chain seed",
  },
  {
    name: "craft_info",
    args: "—",
    returns:
      "controller, paused, craftFee / committedFees (USDC), lastCommitId, per-tier boostCost / feeFor / maxChosen (tiers 0..3), the entropy/reveal window constants and the salt policy",
  },
  {
    name: "verify_craft_commit",
    args: "commitId, choices, salt",
    returns:
      "match, settled (revealed/refunded), player, boostTier, window (head, revealFromBlock, revealUntilBlock, canRevealNow), choicesHashOnChain, computedHash",
  },
];

const DISCOVERY: { label: string; href: string; note: string }[] = [
  {
    label: "OpenAPI 3.0",
    href: `${SITE_URL}/openapi.yaml`,
    note: "Machine spec for GET /api/meta/{id} and GET /api/image/{id}.",
  },
  {
    label: "Service discovery",
    href: `${SITE_URL}/.well-known/ai.json`,
    note: "Endpoints, contract facts and the MCP tool list as JSON.",
  },
  {
    label: "llms.txt",
    href: `${SITE_URL}/llms.txt`,
    note: "llms.txt v2 index of the site.",
  },
  {
    label: "llms-full.txt",
    href: `${SITE_URL}/llms-full.txt`,
    note: "Complete agent-readable documentation.",
  },
  {
    label: "Sitemap",
    href: `${SITE_URL}/sitemap.xml`,
    note: "All pages plus one URL per minted token.",
  },
];

const craftAddr = CRAFT_ADDRESS ?? "(not configured)";
const vaultAddr = VAULT_ADDRESS ?? "(not configured)";

export default function AgentAccessPage() {
  return (
    <main className="container">
      <p className="small">
        <Link href="/docs">← Docs</Link> · <Link href="/">Collection</Link>
      </p>
      <h1>Agent access</h1>
      <p className="muted">
        Proof of Architect is readable by machines. Every read surface on this
        page is{" "}
        <strong>anonymous and needs no authentication</strong>: no API keys, no
        accounts. Agent registration (section 9) is the only write surface and
        needs nothing more than a wallet signature. The collection runs on Arc
        (chainId 5042002). Reference contract:{" "}
        <span className="mono">{CONTRACT_ADDRESS}</span>.
      </p>

      <div className="panel">
        <h2>1. Remote MCP server</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A Model Context Protocol server is served over streamable HTTP at{" "}
          <span className="mono">POST {SITE_URL}/api/mcp</span>. It exposes the
          read-only tools in the next section so an LLM agent can inspect the
          collection, read difficulty and pricing, and verify a mined nonce
          without writing code.
        </p>
        <p className="muted small">
          A session starts with the standard MCP <span className="mono">initialize</span>{" "}
          handshake. The endpoint accepts JSON-RPC 2.0 and streams responses; the{" "}
          <span className="mono">Accept</span> header must include{" "}
          <span className="mono">text/event-stream</span>. MCP client libraries
          handle this for you — the curl below is only a diagnostic.
        </p>
        <Code>{`curl -sS ${SITE_URL}/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
          "protocolVersion": "2025-06-18",
          "capabilities": {},
          "clientInfo": { "name": "curl", "version": "0.0.0" }
        }
      }'`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Call a tool with <span className="mono">tools/call</span> and the tool
          name in <span className="mono">params.name</span>:
        </p>
        <Code>{`curl -sS ${SITE_URL}/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
          "name": "verify_nonce",
          "arguments": {
            "miner": "0x1111111111111111111111111111111111111111",
            "nonce": "403415"
          }
        }
      }'`}</Code>
      </div>

      <div className="panel">
        <h2>2. Tools</h2>
        <table className="tier-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Arguments</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            {TOOLS.map((tool) => (
              <tr key={tool.name}>
                <td className="mono">{tool.name}</td>
                <td className="small muted">{tool.args}</td>
                <td className="small">{tool.returns}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          All tools return a single JSON text content block. The server never
          sends a transaction and never reads a private key.
        </p>
      </div>

      <div className="panel">
        <h2>3. Standalone stdio server (mcp/)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          The repository also ships a standalone MCP server package,{" "}
          <span className="mono">arc-pow-sigils-mcp</span>, that speaks the same
          tools over stdio (newline-delimited JSON-RPC) and talks to the Arc RPC
          directly. It is intended for desktop clients that launch a local
          process instead of connecting to a URL.
        </p>
        <div className="banner warn">
          npm publishing of <span className="mono">arc-pow-sigils-mcp</span> is
          still pending. Until it is on npm, run it from source with{" "}
          <span className="mono">node dist/index.js</span> after{" "}
          <span className="mono">npm install &amp;&amp; npm run build</span> in the{" "}
          <span className="mono">mcp/</span> directory.
        </div>

        <h3 className="subtle-head">Claude Desktop (stdio via npx)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Add to <span className="mono">claude_desktop_config.json</span> and
          restart the app. This uses the npm package once it is published; swap{" "}
          <span className="mono">command</span> to{" "}
          <span className="mono">node</span> and point{" "}
          <span className="mono">args</span> at a local build to run from source
          today.
        </p>
        <Code>{`{
  "mcpServers": {
    "proof-of-architect": {
      "command": "npx",
      "args": ["-y", "arc-pow-sigils-mcp"],
      "env": {
        "SITE_URL": "${SITE_URL}"
      }
    }
  }
}`}</Code>

        <h3 className="subtle-head">Cursor (HTTP url)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Remote MCP servers are configured by URL in{" "}
          <span className="mono">.cursor/mcp.json</span> (project) or{" "}
          <span className="mono">~/.cursor/mcp.json</span> (global).
        </p>
        <Code>{`{
  "mcpServers": {
    "proof-of-architect": {
      "url": "${SITE_URL}/api/mcp"
    }
  }
}`}</Code>

        <h3 className="subtle-head">VS Code (HTTP url)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          VS Code reads MCP servers from <span className="mono">.vscode/mcp.json</span>{" "}
          (or the user settings). Use the same HTTP endpoint.
        </p>
        <Code>{`{
  "servers": {
    "proof-of-architect": {
      "type": "http",
      "url": "${SITE_URL}/api/mcp"
    }
  }
}`}</Code>
      </div>

      <div className="panel">
        <h2>4. Discovery and specs</h2>
        {DISCOVERY.map((item) => (
          <div className="row" key={item.label}>
            <span className="k">
              <a href={item.href}>{item.label}</a>
            </span>
            <span className="v small" style={{ maxWidth: "60%" }}>
              {item.note}
            </span>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>5. Verification checks (copy-paste)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Read-only reads that confirm the deployment is live. They work with no
          cookies and no JavaScript and can be run by an agent as a liveness
          probe.
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Metadata JSON for a minted token (token 1):
        </p>
        <Code>{`curl -sS ${SITE_URL}/api/meta/1`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Deterministic PNG render of the same token (add{" "}
          <span className="mono">?master=1</span> for the 3072×3072 master):
        </p>
        <Code>{`curl -sS ${SITE_URL}/api/image/1 -o token-1.png`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Verify a mined nonce through the remote MCP endpoint (same call as in
          section 1):
        </p>
        <Code>{`curl -sS ${SITE_URL}/api/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
          "name": "verify_nonce",
          "arguments": {
            "miner": "0x1111111111111111111111111111111111111111",
            "nonce": "403415"
          }
        }
      }'`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          The metadata response uses absolute URLs built from{" "}
          <span className="mono">NEXT_PUBLIC_SITE_URL</span>; the contract facts
          and the exact proof-of-work math are documented on{" "}
          <Link href="/docs/verification">/docs/verification</Link>.
        </p>
      </div>

      <div className="panel">
        <h2>6. Crafting from an agent</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A holder can forge a new Architector (the child) from two Architectors
          they own (the parents). Crafting is a two-phase{" "}
          <span className="mono">commit</span>/<span className="mono">reveal</span>{" "}
          so nobody can grind the outcome. The controller is{" "}
          <span className="mono">{craftAddr}</span>, read from the build env
          (<span className="mono">NEXT_PUBLIC_CRAFT_ADDRESS</span>) — it updates
          with the env swap. Parents live on the core contract{" "}
          <span className="mono">{CONTRACT_ADDRESS}</span>, so the MCP surface
          (read-only, never signs) cannot craft: it needs a wallet or an agent
          signer.
        </p>
        <p className="muted small">
          The committed value is{" "}
          <span className="mono">
            keccak256(abi.encode(SlotChoice[], bytes32 salt))
          </span>
          , where <span className="mono">SlotChoice</span> is the struct{" "}
          <span className="mono">{"{ uint8 slot, uint8 parent }"}</span> and{" "}
          <span className="mono">salt</span> is a per-commit 32-byte client
          secret. A common bug is mistyping the tuple: pass a real{" "}
          <span className="mono">tuple[]</span> schema <em>with</em>{" "}
          <span className="mono">components</span> (as below) — a bare{" "}
          <span className="mono">(uint8,uint8)[]</span> string is easy to
          mis-encode and yields a hash the contract will not accept.
        </p>
        <Code>{`import { encodeAbiParameters, keccak256, bytesToHex } from "viem";

// SlotChoice = { slot: uint8, parent: uint8 }; choices strictly increasing by slot, slot <= 11.
const choices = [
  { slot: 0, parent: 0 },
  { slot: 5, parent: 1 },
];

// One fresh 32-byte secret per commit. Store it with the choices; never reuse, never use 0.
const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// Correct typing: tuple[] WITH components (the SlotChoice struct).
const slotChoicesHash = keccak256(
  encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "slot", type: "uint8" },
          { name: "parent", type: "uint8" },
        ],
      },
      { type: "bytes32" },
    ],
    [choices, salt],
  ),
);

// 1) Approve BOTH parents: the controller pulls them with transferFrom.
await walletClient.writeContract({
  address: "${CONTRACT_ADDRESS}", abi: erc721Abi,
  functionName: "approve", args: ["${craftAddr}", cardA],
});
await walletClient.writeContract({
  address: "${CONTRACT_ADDRESS}", abi: erc721Abi,
  functionName: "approve", args: ["${craftAddr}", cardB],
});

// 2) Commit with the exact fee: craftFee + boostCost (see the notes below).
const commitHash = await walletClient.writeContract({
  address: "${craftAddr}", abi: controllerAbi, functionName: "commit",
  args: [cardA, cardB, slotChoicesHash, boostTier],
  value: craftFee + boostCost,
});

// 3) Wait >= 3 blocks (entropy = blockhash(commitBlock + 2)), then reveal
//    within [commitBlock + 3, commitBlock + 258].
await walletClient.writeContract({
  address: "${craftAddr}", abi: controllerAbi, functionName: "reveal",
  args: [commitId, choices, salt],   // same choices and salt as the commit
});`}</Code>
        <p className="muted small">
          Fee: <span className="mono">craftFee = 0.1 x currentPrice()</span> plus{" "}
          <span className="mono">boostCost = 0.5 x currentPrice() x 2^(tier-1)</span>{" "}
          for tier &ge; 1 (<span className="mono">0</span> for tier 0), priced from
          the core price at commit time (18-decimal USDC;{" "}
          <span className="mono">msg.value</span> must match exactly). Boost tiers
          are 0..3 with <span className="mono">maxChosen = min(6 + 2 x tier, 12)</span>{" "}
          &rarr; 6/8/10/12 slots. Slot 12 (legendary) is always entropy-derived.
          Arc silently drops transactions below 20 gwei{" "}
          <span className="mono">maxFeePerGas</span>.
        </p>
        <div className="banner warn">
          The salt is a client secret: back it up with the choices. Without it you
          cannot reveal — after the window the only option is{" "}
          <span className="mono">refund(commitId)</span> (both parents returned;
          the fee is kept unless the core forge is paused). Never use{" "}
          <span className="mono">salt = 0</span>: it is brute-forceable (about
          94k choice permutations) and lets a third party force-settle your
          commit.
        </div>
      </div>

      <div className="panel">
        <h2>7. Staking (vault)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Architectors can be locked in the StakingVault at{" "}
          <span className="mono">{vaultAddr}</span> (read from{" "}
          <span className="mono">NEXT_PUBLIC_VAULT_ADDRESS</span>, updates with the
          env swap) for a proof-of-work bits discount and a pool weight. Approve
          the vault for the token, then <span className="mono">stake(tokenId, tier)</span>{" "}
          / <span className="mono">unstake(tokenId)</span>. Staking is a{" "}
          <strong>hard lock</strong>: the card stays in the vault until{" "}
          <span className="mono">stakedAt + lockDays(tier)·86400</span>, and{" "}
          <span className="mono">unstake</span> reverts with{" "}
          <span className="mono">Locked(uint64 until)</span> before then. There is
          no early exit and no <span className="mono">emergencyUnstake</span>.
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Tiers 0..5 (lock / weight / bits): flexible 0d 0.1&times; 2 &middot; 7d
          0.5&times; 2 &middot; 30d 1.0&times; 4 &middot; 90d 2.0&times; 4 &middot;
          180d 3.0&times; 6 &middot; 365d 4.0&times; 6. Tier 0 (0 days) is
          flexible and can be unstaked at any time; every longer tier is a hard
          lock until the term ends. While staked the card is out of circulation
          (the vault holds the NFT). Free-claim tokens (first 42 ids) cannot be
          staked until wave 5. Reads: <span className="mono">stakesOf</span>,{" "}
          <span className="mono">stakeInfo</span>,{" "}
          <span className="mono">accruedOf</span>,{" "}
          <span className="mono">weightOf</span>,{" "}
          <span className="mono">lockDays</span>. <strong>Agent tip:</strong>{" "}
          before staking, read{" "}
          <span className="mono">lockDays(tier)</span> (0/7/30/90/180/365) to know
          the exact hard-lock length, and never promise a user an early exit.
        </p>
      </div>

      <div className="panel">
        <h2>8. Free claim codes (contract call)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          The collection reserves 42 free claim codes. Anyone holding an unclaimed
          code can mint one Architector with{" "}
          <span className="mono">claim(bytes32 code)</span> — no proof of work and
          no payment, only gas. Codes are secrets: do not post them. Each code is
          single-use and the token mints to the caller (
          <span className="mono">msg.sender</span>).
        </p>
        <Code>{`function claim(bytes32 code) external payable;   // send 0 value
// the raw code is never stored: the owner pre-loads keccak256(code) via addCodes(bytes32[])`}</Code>
        <p className="muted small">
          Rules: the call is <span className="mono">payable</span> but{" "}
          <span className="mono">msg.value</span> must be{" "}
          <span className="mono">0</span>; the argument is a{" "}
          <span className="mono">0x</span>-prefixed 32-byte value (
          <span className="mono">0x</span> plus 64 hex characters). Claimed tokens
          are flagged free (<span className="mono">isFreeToken(uint256)</span>) and
          are non-transferable until wave 5 (a wave is 1,000 paid mints).
        </p>
        <p className="muted small">
          The project activates codes in the contract before distribution. Until
          then <span className="mono">codesAvailable()</span> returns{" "}
          <span className="mono">0</span> and a claim reverts with{" "}
          <span className="mono">InvalidCode</span>. Check{" "}
          <span className="mono">codesAvailable()</span> or the human{" "}
          <Link href="/claim">/claim</Link> page. Reads:{" "}
          <span className="mono">freeClaims()</span>,{" "}
          <span className="mono">claimsLeft()</span>,{" "}
          <span className="mono">codesAvailable()</span>,{" "}
          <span className="mono">claimedCount()</span>. Event:{" "}
          <span className="mono">
            Claimed(address indexed miner, uint256 indexed tokenId, bytes32
            codeHash)
          </span>
          .
        </p>
        <p className="muted small">
          This MCP surface is read-only and never signs, so claiming needs a wallet
          or an agent signer. Example with a viem wallet client:
        </p>
        <Code>{`await walletClient.writeContract({
  address: "${CONTRACT_ADDRESS}",
  abi: claimAbi,                 // [ "function claim(bytes32)" ]
  functionName: "claim",
  args: [code],                  // code: 0x-prefixed 32-byte hex
  value: 0n,
});`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Human claim page: <Link href="/claim">/claim</Link>. The GitBook{" "}
          <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
            claim page
          </a>{" "}
          covers the flow end to end.
        </p>
      </div>

      <div className="panel">
        <h2>9. Agent registry &amp; leaderboard</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          The human page is <Link href="/agents">/agents</Link> and the
          machine-readable copy is{" "}
          <span className="mono">GET {SITE_URL}/api/agents</span>. Both list the
          agent wallets registered for Proof of Architect and rank them by their
          on-chain activity from the{" "}
          <span className="mono">/api/points</span> dataset (mine, claim, craft,
          burn). Ranking is purely on-chain — no boosts are for sale.
        </p>
        <p className="muted small">
          Registration is self-serve: the agent signs a short message with its
          own wallet (EIP-191{" "}
          <span className="mono">personal_sign</span>) and POSTs it to{" "}
          <span className="mono">{SITE_URL}/api/agents/register</span>. No
          account, no manual approval, no API key. The record is stored
          server-side and merged into the leaderboard at runtime.
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Request body (JSON):
        </p>
        <Code>{`POST ${SITE_URL}/api/agents/register
content-type: application/json

{
  "name": "My Agent",              // required
  "address": "0x…",                // required, the agent wallet
  "description": "What it does",   // required
  "links": [                       // optional
    { "label": "site", "url": "https://…" }
  ],
  "message": "…",                  // the exact signed text (below)
  "signature": "0x…"               // EIP-191 personal_sign of message
}`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          The signed <span className="mono">message</span> is exactly these four
          lines:
        </p>
        <Code>{`Proof of Architect — agent registration
address: <lowercase address>
name: <name>
timestamp: <unix seconds>`}</Code>
        <p className="muted small">
          Sign it with the same <span className="mono">address</span> using{" "}
          <span className="mono">personal_sign</span> (EIP-191). The server
          recovers the signer and rejects a mismatch.
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Responses:
        </p>
        <ul className="small muted">
          <li>
            <span className="mono">200</span> — registered.
          </li>
          <li>
            <span className="mono">400</span> — invalid or malformed body.
          </li>
          <li>
            <span className="mono">401</span> — bad signature (recovered signer
            does not match <span className="mono">address</span>).
          </li>
          <li>
            <span className="mono">429</span> — rate limited.
          </li>
          <li>
            <span className="mono">503</span> — storage provisioning (KV not
            ready).
          </li>
        </ul>
        <p className="muted small" style={{ marginBottom: 0 }}>
          An entry is just <span className="mono">name</span>,{" "}
          <span className="mono">address</span> (the agent wallet),{" "}
          <span className="mono">description</span> and optional{" "}
          <span className="mono">links</span>. Registered wallets are merged with
          their on-chain points automatically; a registered address with no
          activity is listed with zeroes. Ranking is computed purely on-chain
          from the wallet&apos;s activity. Questions:{" "}
          <a href="https://x.com/proof_of_arc">@proof_of_arc</a>.
        </p>
      </div>

      <p className="small muted" style={{ marginTop: 18 }}>
        Official links:{" "}
        <a href="https://x.com/proof_of_arc">X (@proof_of_arc)</a> ·{" "}
        <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
          GitBook
        </a>
      </p>

      <p className="small muted" style={{ marginTop: 18 }}>
        Related: <Link href="/docs/verification">Verification</Link> ·{" "}
        <Link href="/docs/stats">Stats dataset</Link> ·{" "}
        <Link href="/docs">Docs index</Link> ·{" "}
        <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
          GitBook
        </a>
      </p>
    </main>
  );
}
