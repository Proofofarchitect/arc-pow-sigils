// Parity gate: web/lib/hc2.ts (TS mirror) must match the Python reference
// vectors in art/test_vectors_hc2_v2.json (hc2/2 — ARC-traits/2 crafted set).
//
// v3.4 post-inclusion scheme. Per vector:
//   (1)   computeChildSeed(choices) == childSeed   (v2 PRE-seed, no entropy)
//   (2)   computeDisplaySeed(childSeed, entropy) == displaySeed
//   (3..17) all 15 deriveHC2V2 attributes (from the DISPLAY seed) == attributes
//   (18)  golden flag false
//
// Exact string equality + lowercase hex equality (no tolerance).
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:hc2v2
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeChildSeed, computeDisplaySeed, deriveHC2V2 } from "../lib/hc2.ts";
import { ARC_TRAITS_SLOTS } from "../lib/traits_v2.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../art/test_vectors_hc2_v2.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));

const SLOTS = ARC_TRAITS_SLOTS.map((slot) => slot.name);

let checks = 0;
const failures = [];

for (let i = 0; i < doc.vectors.length; i++) {
  const vector = doc.vectors[i];
  const choices = vector.choices.map(([slot, parent]) => ({ slot, parent }));

  // (1) v2 PRE-seed — packed keccak256 over "PoA_CRAFT_v2" + choices hash.
  const preSeed = computeChildSeed({
    seedLow: vector.seedLow,
    seedHigh: vector.seedHigh,
    minId: BigInt(vector.minId),
    maxId: BigInt(vector.maxId),
    boostTier: vector.boostTier,
    craftNonce: BigInt(vector.craftNonce),
    choices,
  });
  checks++;
  if (preSeed !== vector.childSeed) {
    failures.push(
      `vector[${i}] childSeed (pre-seed): expected ${vector.childSeed} got ${preSeed}`,
    );
  }

  // (2) DISPLAY seed = keccak256(preSeed ‖ entropy).
  const displaySeed = computeDisplaySeed(preSeed, vector.entropy);
  checks++;
  if (displaySeed !== vector.displaySeed) {
    failures.push(
      `vector[${i}] displaySeed: expected ${vector.displaySeed} got ${displaySeed}`,
    );
  }

  // (3..17) all 15 v2 attributes derived from the reference DISPLAY seed
  // (isolates derivation from any pre-seed/display-seed issue).
  const result = deriveHC2V2(
    vector.displaySeed,
    vector.seedLow,
    vector.seedHigh,
    choices,
  );

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

  // v2 has no golden/bug conditionals — the flag is always false.
  checks++;
  if (result.golden !== false) {
    failures.push(`vector[${i}] golden flag should be false`);
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
  `PASS ${doc.vectors.length}/${doc.vectors.length} vectors \u00b7 ${checks} checks (pre-seed + displaySeed + 15 v2 attributes + golden flag)`,
);
