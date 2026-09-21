// Parity gate: web/lib/hc2.ts (TS mirror) must match the Python reference
// vectors in art/test_vectors_hc2.json (hc2/1 — house-card crafted set).
//
// Per vector: (1..15) all 15 deriveHC2 attributes == attributes, (16) golden
// flag consistency. = 16 checks/vector.
//
// NOTE (v3.4): the v1 childSeed FORMULA (`PoA_CRAFT_v1` + entropy) no longer
// exists on-chain — crafting uses the v2 pre-seed (`PoA_CRAFT_v2`, no entropy)
// followed by a post-inclusion display seed. `deriveHC2` itself is unchanged and
// still used for the house-card HC/2 path, and its attributes are a pure
// function of the seed, so this gate feeds the reference `childSeed` as the
// seed input (the derivation is what is under test here).
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:hc2
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveHC2 } from "../lib/hc2.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../art/test_vectors_hc2.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));

const SLOTS = [
  "background",
  "body",
  "outfit",
  "face",
  "eyes",
  "headwear",
  "era",
  "origin",
  "quote",
  "lore",
  "tool",
  "companion",
  "legendary",
  "golden",
  "bug",
];

let checks = 0;
const failures = [];

for (let i = 0; i < doc.vectors.length; i++) {
  const vector = doc.vectors[i];

  // (1..15) all 15 attributes derived from the reference seed (isolates the
  // derivation from the retired childSeed formula).
  const choices = vector.choices.map(([slot, parent]) => ({ slot, parent }));
  const result = deriveHC2(vector.childSeed, vector.seedLow, vector.seedHigh, choices);

  for (const name of SLOTS) {
    checks++;
    if (result.attributes[name] !== vector.attributes[name]) {
      failures.push(
        `vector[${i}] ${name}: expected ${JSON.stringify(
          vector.attributes[name],
        )} got ${JSON.stringify(result.attributes[name])}`,
      );
    }
  }

  // (16) golden flag consistency.
  checks++;
  const expectedGolden = vector.attributes.golden !== "None";
  if (expectedGolden !== result.golden) {
    failures.push(
      `vector[${i}] golden flag: expected ${expectedGolden} got ${result.golden}`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  \u2717 ${failure}`);
  console.error(
    `FAIL \u2014 ${failures.length} mismatch(es) across ${doc.vectors.length} vectors (${checks} checks)`,
  );
  process.exit(1);
}

console.log(
  `PASS ${doc.vectors.length}/${doc.vectors.length} vectors \u00b7 ${checks} checks (15 attributes + golden flag)`,
);
