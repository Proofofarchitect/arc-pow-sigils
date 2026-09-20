// Render smoke test — derives seeds, renders via the web renderer (sharp) and
// writes PNGs to art/ai/out/web_smoke/. Run: npx tsx scripts/render-smoke.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAttributes } from "../lib/traits.ts";
import { renderHouseCardPng } from "../lib/renderer.ts";
import { keccak256, toHex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../art/ai/out/web_smoke");
mkdirSync(out, { recursive: true });

const hex = (n) => keccak256(toHex(BigInt(n))); // arbitrary distinct 32-byte seeds

const wanted = [
  ["kippah", (v) => v.headwear === "Kippah"],
  ["golden-house-cat", (v, d) => d.golden && v.companion === "House Cat"],
  ["10b-mint", (v) => v.legendary === "10B Mint"],
  ["the-silence", (v) => v.legendary === "The Silence"],
  ["golden-fat-rat", (v, d) => d.golden && v.companion === "Fat Rat"],
];

const found = new Map();
for (let i = 1; i <= 20000 && found.size < wanted.length; i++) {
  const seed = hex(i);
  const d = deriveAttributes(seed);
  const v = Object.fromEntries(d.attributes.map((a) => [a.slot, a.value]));
  for (const [name, pred] of wanted) {
    if (!found.has(name) && pred(v, d)) {
      found.set(name, { i, seed, v, d });
    }
  }
}

for (const [name, { i, seed, v, d }] of found) {
  const png = await renderHouseCardPng(d, {});
  const p = resolve(out, `${name}__seed_${i}.png`);
  writeFileSync(p, png);
  console.log(
    `${name}: seed#${i} ${seed.slice(0, 10)}…  headwear=${v.headwear} companion=${v.companion} legendary=${v.legendary} golden=${d.golden} -> ${p}`,
  );
}
if (found.size === 0) {
  console.error("no interesting seeds found in scan window");
  process.exit(1);
}
