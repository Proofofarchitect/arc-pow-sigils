#!/usr/bin/env node
/**
 * check-addresses.mjs — address-sync gate (single source of truth).
 *
 * WHY: the DOC-48-01 incident — after the site cut over to a new core, stale
 * hardcoded addresses lingered in docs/env, so the public surface pointed at
 * the wrong contract. This gate makes that class of drift a build failure.
 *
 * HOW:
 *  - The canonical set is parsed from web/lib/canonical.ts (the one place
 *    addresses may be defined).
 *  - Every ACTIVE source/doc file is scanned for a superseded (STALE) contract
 *    address; any hit is a FAILURE.
 *  - A set of key files MUST contain the canonical core address.
 *  - Other non-canonical 40-hex values are reported as informational only
 *    (test vectors, throwaway addresses).
 *
 * Exit 1 on any stale address or missing canon. Run: npm run check:addresses
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", ".."); // web/scripts -> repo root

// --- canonical set (single source of truth) --------------------------------
const CANON_FILE = join(ROOT, "web", "lib", "canonical.ts");
const canonSrc = readFileSync(CANON_FILE, "utf8");
const CANON = new Set(
  (canonSrc.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) || []).map((a) =>
    a.toLowerCase(),
  ),
);
const CANON_CORE = "0x3E20bb7be2C46f94Cab78d340D3F79Afc2a9Fed4";

// --- superseded deployment addresses: must NOT appear in active files ------
const STALE = [
  "0xc7D2C2cC9291485ec8B727333B6a1478Dd66c3D5", // v2 core
  "0xCc223C0e1A943916f604d729Cddfb5B85f266193", // v3 core
  "0x2F7cE1e4A175b1A16e4f151fA5B862ea6b9F3C8b", // v3.1 core
  "0xdecF76cC4dc98985f4A07cD0D7A8fcF31491c7D2", // v3.3 core
  "0x26867a976481AE28e385fB689D6B1ba58bC1D508", // v3.3 vault
  "0x391Ab12FbEb0e4f729CDC7b58d0461103851bD5E", // v3.3 craft
  "0x1542c820cF8644Abb91BF5c275097f89578FC3A9", // v3.2 craft
  "0xF3E861085D5569d3eb376277a3F3D87579E94b09", // old craft (v1)
  "0x801e10dAa6C38996226aA9D5C61741A491ccf89b", // v3.1 vault
  "0x520a710099badd2e6cc07832cbbac032470160cf", // v3.1 vault v2
  "0x8f5795343C10b316296f6767a10e87CC40E62491", // v3.4 core (testnet — superseded by mainnet 2026-09-21)
  "0xb19391b0Ce967f473665691295F2846C424c720a", // v3.4 vault (testnet)
  "0x5F7f7D3E641D09565Cf6f81D461bA09910f6685F", // v3.4 craft (testnet)
  "0x9Ce1cD8d4Bdcba89A2be6E0021FD073DDDa3CD47", // registry (testnet)
  "0x593973Ce94A82282a7d6f4bbf384CCd852d160a1", // rewards (testnet)
  "0xD964C910DDa776Da55A900F85b019f48C237EA8b", // points (testnet)
].map((a) => a.toLowerCase());

// --- active surfaces to scan ----------------------------------------------
const TARGETS = [
  "web/lib",
  "web/app",
  "web/public",
  "web/.env.local.example",
  "mcp/src",
  "miner",
  "gitbook",
  "README.md",
  "MECHANICS_EXPLAINED.md",
  "domain_fork/lib",
  "domain_fork/app",
  "domain_fork/public",
  "domain_fork/deploy",
  "domain_fork/.env.local.example",
  "domain_fork/README.md",
];
const opsDir = join(ROOT, "ops");
if (existsSync(opsDir)) {
  for (const f of readdirSync(opsDir)) {
    if (f.endsWith(".py")) TARGETS.push(join("ops", f));
  }
}

// Intentional historical / verbatim reference files.
const ALLOW_PATHS = [
  "web/app/changelog.xml", // dated changelog keeps historical addresses
  "web/app/docs/verification", // intentional historical reference vector
  "domain_fork/app/docs/verification", // same historical reference vector
  "miner/E2E_RESULTS.md", // historical run log
  "miner/miner-worker.original.js", // verbatim pre-fix reference
  "canonical.ts", // the source itself
  "domain_fork/plans", // dated snapshots of root plans
  "domain_fork/app/changelog.xml", // dated changelog
  "node_modules",
  ".next",
  "/dist/", // built output
  ".git",
];

// Files that must carry the canonical core (full 40-hex form).
const MUST_CONTAIN_CORE = [
  "web/lib/contract.ts",
  "web/.env.local.example",
  "mcp/src/chain.ts",
  "gitbook/contracts.md",
  "miner/load-worker.mjs",
  "ops/revenue_ledger.py",
  "domain_fork/lib/contract.ts",
];

const EXTS = new Set([
  ".ts", ".tsx", ".mjs", ".js", ".md", ".json", ".yaml", ".yml", ".txt", ".py", ".html", ".example",
]);

function allowed(rel) {
  return ALLOW_PATHS.some((a) => rel.includes(a));
}

function walk(target, out) {
  const abs = join(ROOT, target);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(target);
    return;
  }
  for (const name of readdirSync(abs)) {
    const rel = join(target, name);
    if (allowed(rel)) continue;
    const s = statSync(join(ROOT, rel));
    if (s.isDirectory()) walk(rel, out);
    else if (EXTS.has(extname(name))) out.push(rel);
  }
}

const ADDR = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

const files = [];
for (const t of TARGETS) walk(t, files);

const staleHits = [];
const otherHits = [];
for (const rel of files) {
  if (allowed(rel)) continue;
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const m of ln.match(ADDR) || []) {
      const low = m.toLowerCase();
      if (STALE.includes(low)) staleHits.push(`${rel}:${i + 1}  ${m}`);
      else if (!CANON.has(low)) otherHits.push(`${rel}:${i + 1}  ${m}`);
    }
  });
}

const missingCore = [];
for (const rel of MUST_CONTAIN_CORE) {
  const p = join(ROOT, rel);
  // Curated repo: monorepo-only surfaces (ops/, gitbook/, domain_fork/,
  // web/.env.local.example) are intentionally absent here — skip them instead
  // of failing. Files that DO exist must still carry the canonical core.
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8");
  const hasLiteral = src.toLowerCase().includes(CANON_CORE.toLowerCase());
  const importsCanon = /from\s+["'](\.\.?\/)+canonical["']/.test(src);
  if (!hasLiteral && !importsCanon) missingCore.push(rel);
}

// --- report ----------------------------------------------------------------
console.log(`check-addresses: canonical set = ${CANON.size} address(es) from web/lib/canonical.ts`);

if (otherHits.length) {
  console.log(`\n[info] non-canonical 40-hex values (test vectors / constants — not contract refs):`);
  for (const h of otherHits) console.log(`  ${h}`);
}

if (missingCore.length) {
  console.log(`\n[FAIL] canonical core ${CANON_CORE} missing in:`);
  for (const m of missingCore) console.log(`  ${m}`);
}

if (staleHits.length) {
  console.log(`\n[FAIL] superseded contract address in active file:`);
  for (const h of staleHits) console.log(`  ${h}`);
}

if (staleHits.length || missingCore.length) {
  console.log(`\ncheck-addresses: FAIL (${staleHits.length} stale, ${missingCore.length} missing)`);
  process.exit(1);
}
console.log(`\ncheck-addresses: PASS (no stale addresses; canon present in all key files)`);
