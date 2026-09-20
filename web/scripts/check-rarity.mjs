// Cross-check gate: web/lib/rarity.ts (TS port) must match the Python reference
// vectors in art/test_vectors_rarity.json (rarity/1).
//
// Asserts: thresholds (4) + multipliers (5) deep-equality, plus per vector the
// information-content score (±tolerance) and the tier classification.
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:rarity
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RARITY_MULTIPLIERS,
  RARITY_THRESHOLDS,
  rarityForSeed,
} from "../lib/rarity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../art/test_vectors_rarity.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));

const tolerance =
  typeof vectors.tolerance === "number" ? vectors.tolerance : 1e-6;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

let checks = 0;
const failures = [];

// Thresholds (count as 1 check).
checks++;
if (!deepEqual(RARITY_THRESHOLDS, vectors.thresholds)) {
  failures.push(
    `thresholds: expected ${JSON.stringify(vectors.thresholds)} got ${JSON.stringify(
      RARITY_THRESHOLDS,
    )}`,
  );
}

// Multipliers (count as 1 check).
checks++;
if (!deepEqual(RARITY_MULTIPLIERS, vectors.multipliers)) {
  failures.push(
    `multipliers: expected ${JSON.stringify(vectors.multipliers)} got ${JSON.stringify(
      RARITY_MULTIPLIERS,
    )}`,
  );
}

for (let i = 0; i < vectors.vectors.length; i++) {
  const vector = vectors.vectors[i];
  const { score, tier } = rarityForSeed(vector.seed);

  checks++;
  if (!(Math.abs(score - vector.ic) <= tolerance)) {
    failures.push(
      `seed[${i}] ${vector.seed} ic: expected ${JSON.stringify(
        vector.ic,
      )} got ${JSON.stringify(score)}`,
    );
  }

  checks++;
  if (tier !== vector.tier) {
    failures.push(
      `seed[${i}] ${vector.seed} tier: expected ${JSON.stringify(
        vector.tier,
      )} got ${JSON.stringify(tier)}`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    `FAIL — ${failures.length} mismatch(es) across ${vectors.vectors.length} vectors (${checks} checks)`,
  );
  process.exit(1);
}

console.log(
  `PASS ${vectors.vectors.length}/${vectors.vectors.length} vectors · ${checks} checks (thresholds + multipliers + ic ±tol + tier)`,
);
