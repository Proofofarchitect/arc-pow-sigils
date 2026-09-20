// Parity gate: web/lib/hc2.ts (TS mirror) must match the Python reference
// vectors in art/test_vectors_hc2.json (hc2/1).
//
// Per vector: (1) computeChildSeed == childSeed, (2..16) all 15 deriveHC2
// attributes == attributes, (17) golden flag consistency
// (attributes.golden !== "None"  <->  result.golden). = 17 checks/vector.
//
// Exact string equality + lowercase hex equality (no tolerance).
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:hc2
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeChildSeed, deriveHC2 } from "../lib/hc2.ts";

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

  // (1) childSeed — packed keccak256.
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

  // (2..16) all 15 attributes from the reference childSeed (isolates derivation
  // from any childSeed issue).
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

  // (17) golden flag consistency.
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
  `PASS ${doc.vectors.length}/${doc.vectors.length} vectors \u00b7 ${checks} checks (childSeed + 15 attributes + golden flag)`,
);
