import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { SITE_URL } from "@/lib/site";
import { ARC_CHAIN_ID, CONTRACT_ADDRESS } from "@/lib/contract";

export const metadata: Metadata = {
  title: "Verification (proof of work) — Proof of Architect",
  description:
    "The exact keccak proof-of-work math of Proof of Architect: the 104-byte preimage, the leading-zero-bit validity rule, the difficulty formula, a worked example and how to verify a nonce.",
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

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export default function VerificationPage() {
  return (
    <main className="container">
      <p className="small">
        <Link href="/docs">← Docs</Link> · <Link href="/">Collection</Link>
      </p>
      <h1>Proof-of-work verification</h1>
      <p className="muted">
        Every Proof of Architect token is produced by grinding a nonce until its
        keccak-256 hash has enough leading zero bits. The winning hash becomes the
        token seed, so the work is fully verifiable after the fact. This page
        specifies the exact math, the difficulty formula and a real worked
        example. Reference contract (Arc):{" "}
        <span className="mono">{CONTRACT_ADDRESS}</span>.
      </p>

      <div className="panel">
        <h2>1. Preimage and hash</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          The value being hashed is a packed 104-byte string — three integers and
          two addresses, in this exact order, with no padding between fields:
        </p>
        <Code>{`work = keccak256(
    abi.encodePacked(
        uint256 chainId,   // 32 bytes, big-endian
        address contract,  // 20 bytes
        address miner,     // 20 bytes
        uint256 nonce      // 32 bytes, big-endian
    )
)

// 32 + 20 + 20 + 32 = 104 bytes
// 104 < 136 = the Keccak-256 rate block, so one hash pass`}</Code>
        <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 20 }}>
          <li>
            <span className="mono">chainId</span> is {ARC_CHAIN_ID} on Arc; the
            nonce is a full <span className="mono">uint256</span> (big-endian),
            not a small counter.
          </li>
          <li>
            Addresses are the raw 20 bytes (no checksum casing, no
            <span className="mono"> 0x</span> prefix inside the preimage).
          </li>
          <li>
            The hash is <strong>Keccak-256</strong> (Ethereum flavour), not NIST
            SHA3-256.
          </li>
        </ul>
      </div>

      <div className="panel">
        <h2>2. Validity rule</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A nonce is valid when the value of{" "}
          <span className="mono">work</span> is strictly below the wallet&apos;s
          difficulty target (v3.4 uses a fractional target; requiredMilli can sit
          between whole bits):
        </p>
        <Code>{`valid  <=>  uint256(work) < targetFor(miner)

// targetFor is derived from requiredMilli (milli-bits = thousandths of a bit):
//   requiredMilli = (baseBits + 2*epochIndex + loadAdjust + streakBits)*1000 - stakingDiscountMilli   (floored at baseBits*1000, capped at 250 bits)
// requiredBits(miner) = ceil(requiredMilli/1000) is the display value only.
// Expected number of attempts ~= 2^(requiredMilli/1000).`}</Code>
        <p className="muted small">
          Leading zero <em>bits</em> (not bytes) means a hash starting with{" "}
          <span className="mono">0x00</span> has at least 8 valid bits,{" "}
          <span className="mono">0x0000</span> at least 16, and so on. A 30-bit
          difficulty requires roughly one billion hashes on average.
        </p>
      </div>

      <div className="panel">
        <h2>3. Difficulty formula</h2>
        <Code>{`requiredMilli(miner) =
    max( baseBits * 1000,
         ( baseBits + 2 * epochIndex + loadAdjust + streakBits ) * 1000
                  - stakingDiscountMilli(miner) )   // capped at 250 bits

targetFor(miner) = 2^(256 - intPart) / 2^(tenths/10)   // intPart=tenths split from requiredMilli`}</Code>
        <table className="tier-table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Term</th>
              <th>Meaning</th>
              <th>Units</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">baseBits</td>
              <td className="small">
                Wave-1 base difficulty of the deployment (30 bits on the current
                deployment).
              </td>
              <td className="mono small">bits</td>
            </tr>
            <tr>
              <td className="mono">2 * epochIndex</td>
              <td className="small">
                +2 bits per wave; each wave is about 4× harder. The 1-based
                wave reported on-chain is <span className="mono">epochIndex + 1</span>
                {" "}(epochs of 1,000 paid mints).
              </td>
              <td className="mono small">bits</td>
            </tr>
            <tr>
              <td className="mono">loadAdjust</td>
              <td className="small">
                Load regulator, 0..64 bits, nudged every 5 mints toward a target
                pace of 25 s/mint (+2 bits when too fast, -1 bit when slow; a
                ±20% dead zone between tightening and loosening).
              </td>
              <td className="mono small">bits</td>
            </tr>
            <tr>
              <td className="mono">streakBits</td>
              <td className="small">
                Per-wallet streak: +2 bits for each extra mint from the same
                wallet while inside its cooldown (cooldown = flat 5–25 min by
                streak level, capped at 25). Resets once the cooldown has
                elapsed.
              </td>
              <td className="mono small">bits</td>
            </tr>
            <tr>
              <td className="mono">stakingDiscountMilli(miner)</td>
              <td className="small">
                PoW discount granted by the staking vault (up to 6 bits,
                floored at baseBits) — see below.
              </td>
              <td className="mono small">bits</td>
            </tr>
          </tbody>
        </table>

        <h3 className="subtle-head">Staking discount (current core)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          A holder can lock an Architector in the staking vault to lower personal
          difficulty. The discount is the maximum over the wallet active stakes,
          capped at 6 bits, and the result is floored at{" "}
          <span className="mono">baseBits</span>:
        </p>
        <table className="tier-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Lock</th>
              <th>Discount (milli-bits)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono small">0</td>
              <td className="small">0 days (flexible)</td>
              <td className="mono small">0 (no discount)</td>
            </tr>
            <tr>
              <td className="mono small">1</td>
              <td className="small">7 days</td>
              <td className="mono small">500 = 0.5 bits</td>
            </tr>
            <tr>
              <td className="mono small">2</td>
              <td className="small">30 days</td>
              <td className="mono small">1500 = 1.5 bits</td>
            </tr>
            <tr>
              <td className="mono small">3</td>
              <td className="small">90 days</td>
              <td className="mono small">3000 = 3 bits</td>
            </tr>
            <tr>
              <td className="mono small">4</td>
              <td className="small">180 days</td>
              <td className="mono small">4500 = 4.5 bits</td>
            </tr>
            <tr>
              <td className="mono small">5</td>
              <td className="small">365 days</td>
              <td className="mono small">6000 = 6 bits</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          The current deployment has the staking vault registered as a module, so
          the discount applies live: lock an Architector in the staking vault and
          your required bits are reduced by up to 6, floored at baseBits.
        </p>
      </div>

      <div className="panel">
        <h2>4. Worked example (reference vector)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A self-contained, reproducible vector: on the initial v2 testnet
          instance a fresh placeholder wallet at base difficulty (20 bits)
          accepts this nonce. The historical first mint of the collection was
          cross-checked the same way, byte-for-byte, by the browser miner, the
          GPU miner and the MCP server; minter details are omitted here. The
          preimage layout and the validity rule are unchanged in the current v3
          core — only the bound contract address differs.
        </p>
        <div className="panel" style={{ marginTop: 0, background: "var(--paper-blue)" }}>
          <Row k="chainId" v="5042002" />
          <Row k="contract (v2 instance)" v="0xc7D2C2cC9291485ec8B727333B6a1478Dd66c3D5" />
          <Row k="miner" v="0x1111111111111111111111111111111111111111" />
          <Row k="nonce" v="1024085" />
          <Row
            k="work (keccak256 preimage)"
            v="0x00000d2c7a16b7b38b3ffa61dca7d4f810f84ae52b031a74dad6f8c73d715bde"
          />
          <Row k="leadingZeroBits(work)" v="20" />
          <Row k="targetFor(miner)" v="fractional target (work < target)" />
          <Row k="valid" v="true (work < target)" />
        </div>
        <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
          Why 20 bits: the hash begins <span className="mono">0x00 00 0d</span> —
          two zero bytes (16 bits) plus <span className="mono">0x0d = 00001101</span>
          {" "}(4 more leading zeros) = 20. On the v2 instance a wallet with no
          prior mints faces exactly that base difficulty (20 bits), so this
          nonce is accepted. Re-run the check yourself with{" "}
          <span className="mono">mining/gpu/verify_vector.py</span>; real mints
          can be re-verified by passing their{" "}
          <span className="mono">miner</span>/<span className="mono">nonce</span>{" "}
          to <span className="mono">verify_nonce</span>.
        </p>
        <div className="banner">
          Run against the <strong>current</strong> core, the same{" "}
          <span className="mono">verify_nonce</span> call reads the wallet
          difficulty <em>now</em> (30+ bits), so a v2-instance nonce can read as{" "}
          <span className="mono">valid: false</span>. That is expected: validity
          is checked against the difficulty in effect now.
        </div>
      </div>

      <div className="panel">
        <h2>5. How to verify</h2>

        <h3 className="subtle-head">With the MCP tool verify_nonce</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          The remote MCP server exposes{" "}
          <span className="mono">verify_nonce(miner, nonce)</span>. It recomputes{" "}
          <span className="mono">work</span> locally (it does not trust the RPC
          for the PoW verdict) and checks it against{" "}
          <span className="mono">targetFor(miner)</span> read live from the
          contract (<span className="mono">valid ⟺ uint256(work) &lt; target</span>).{" "}
          <span className="mono">miner</span> is a 0x-prefixed address;{" "}
          <span className="mono">nonce</span> is a decimal uint256 string.
        </p>
        <Code>{`tool      : verify_nonce
arguments : { "miner": "0x…", "nonce": "1024085" }
returns   : {
  "miner": "0x…",
  "nonce": "1024085",
  "work": "0x…",
  "target": "0x…",
  "valid": false,
  "note": "valid is checked against the CURRENT target…"
}`}</Code>
        <p className="muted small">
          Companion tools: <span className="mono">required_bits(miner)</span> for
          the current difficulty, and <span className="mono">get_token(tokenId)</span>{" "}
          for a token owner, seed and nonce. See{" "}
          <Link href="/docs/agent-access">/docs/agent-access</Link> for the
          endpoint and client configuration.
        </p>

        <h3 className="subtle-head">With the site API and on-chain reads</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          The metadata endpoint, <span className="mono">GET /api/meta/{"{id}"}</span>,
          serves the derived traits and rarity of a token, but not the raw seed.
          To verify independently, read the three values below from the contract
          (or via the MCP <span className="mono">get_token</span> tool) and
          recompute locally:
        </p>
        <Code>{`read  seedOf(id)      -> bytes32   // the winning work, stored on mint
read  nonceOf(id)     -> uint256
read  ownerOf(id)     -> address   // the miner at mint time
read  mintBlockOf(id) -> uint64    // 0 for claim tokens

recompute  work = keccak256(chainId, contract, owner, nonce)
assert     work == seedOf(id)     // byte-for-byte
display    = mintBlockOf == 0 ? seedOf : keccak256(seedOf ‖ blockhash(mintBlockOf + 2))
// the display seed is what drives traits/art (post-inclusion entropy)`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Example metadata read:
        </p>
        <Code>{`curl -sS ${SITE_URL}/api/meta/1`}</Code>
        <p className="muted small" style={{ marginBottom: 0 }}>
          A quick free difficulty probe: call{" "}
          <span className="mono">eth_estimateGas</span> against{" "}
          <span className="mono">mint()</span> with a fresh nonce. It reverts with{" "}
          <span className="mono">BelowFloor(uint8 got, uint8 need)</span> (selector{" "}
          <span className="mono">0xfcf93064</span>) and reveals the current
          difficulty without a transaction.
        </p>
      </div>

      <div className="panel">
        <h2>6. Why rarity is deterministic</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          There is no server randomness and no oracle. The raw token seed is the
          winning work hash itself (<span className="mono">seedOf(tokenId) = work</span>,
          or the claim hash for a free claim). The ART seed that drives traits is
          the <strong>display seed</strong>:{" "}
          <span className="mono">keccak256(seedOf ‖ blockhash(mintBlockOf + 2))</span>{" "}
          for minted and forged tokens (claim tokens keep{" "}
          <span className="mono">seedOf</span>). The block hash is a future block —
          fixed only after the mint lands — so nobody (not even the miner) can
          grind for a favourable seed. Arc <span className="mono">PREVRANDAO</span>{" "}
          being zero is irrelevant here.
        </p>
        <p className="muted small">
          The Architector traits are a pure function of the display seed: each slot
          is drawn by deterministic weighted rejection sampling, consuming{" "}
          <span className="mono">keccak256(seed ‖ uint8 slotIndex ‖ uint16 counter)</span>{" "}
          read as sixteen big-endian uint16 words. Rarity is then the information
          content of the resulting trait set:{" "}
          <span className="mono">-Σ log2(count(value) / totalTokens)</span>, mapped
          to a tier (Standard, Notable, Rare, Epic, Mythic).
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Consequences: the same display seed always yields the same card and the
          same rarity, and anyone can recompute both from on-chain state. Because
          the display seed is post-inclusion, traits and rarity cannot be previewed
          before minting (the previous pre-mint preview is gone). The score and tier
          are served at <span className="mono">GET /api/meta/{"{id}"}</span> under{" "}
          <span className="mono">rarity</span>.
        </p>
      </div>

      <p className="small muted" style={{ marginTop: 18 }}>
        Related: <Link href="/docs/agent-access">Agent access</Link> ·{" "}
        <Link href="/docs/stats">Stats dataset</Link> ·{" "}
        <Link href="/docs">Docs index</Link> ·{" "}
        <a href="https://proofofarchitect.gitbook.io/proof-of-architect/">
          GitBook
        </a>
      </p>
    </main>
  );
}
