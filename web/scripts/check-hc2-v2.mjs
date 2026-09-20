// Parity gate: web/lib/hc2.ts (TS mirror) must match the Python reference
// vectors in art/test_vectors_hc2_v2.json (hc2/2 — ARC-traits/2 crafted set).
//
// Per vector: (1) computeChildSeed == childSeed (trait-set independent §1),
// (2..16) all 15 deriveHC2V2 attributes == attributes. = 16 checks/vector.
//
// Exact string equality + lowercase hex equality (no tolerance).
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:hc2v2
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeChildSeed, deriveHC2V2 } from "../lib/hc2.ts";
import { ARC_TRAITS_SLOTS } from "../lib/traits_v2.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../art/test_vectors_hc2_v2.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));

const SLOTS = ARC_TRAITS_SLOTS.map((slot) => slot.name);

let checks = 0;
const failures = [];

for (let i = 0; i < doc.vectors.length; i++) {
  const vector = doc.vectors[i];

  // (1) childSeed — same packed keccak256 as house-card/1 (§1 is set-independent).
  const childSeed = computeChildSeed({
    seedLow: vector.seedLow,
    seedHigh: vector.seedHigh,
    minId: BigInt(vector.minId),
    maxId: BigInt(vector.maxId),
    boostTier: vector.boostTier,
    craftNonce: BigInt(vector.craftNonce),
    entropy: vector.entropy,
  });
  checks++;
  if (childSeed !== vector.childSeed) {
    failures.push(
      `vector[${i}] childSeed: expected ${vector.childSeed} got ${childSeed}`,
    );
  }

  // (2..16) all 15 v2 attributes from the reference childSeed (isolates
  // derivation from any childSeed issue).
  const choices = vector.choices.map(([slot, parent]) => ({ slot, parent }));
  const result = deriveHC2V2(vector.childSeed, vector.seedLow, vector.seedHigh, choices);

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
  `PASS ${doc.vectors.length}/${doc.vectors.length} vectors \u00b7 ${checks} checks (childSeed + 15 v2 attributes + golden flag)`,
);
