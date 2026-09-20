// Cross-check gate: web/lib/traits_v2.ts derivation must match
// art/v2/vectors_traits.json for ALL 5 seeds × every slot + the golden flag.
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:traits2
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveAttributesV2, ARC_TRAITS_SLOTS } from "../lib/traits_v2.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../art/v2/vectors_traits.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));

const slotOrder = vectors.slot_order;
if (!Array.isArray(slotOrder) || slotOrder.length !== ARC_TRAITS_SLOTS.length) {
  console.error(
    `vectors_traits.json slot_order must have ${ARC_TRAITS_SLOTS.length} entries`,
  );
  process.exit(1);
}

let checks = 0;
const failures = [];

for (const vector of vectors.vectors) {
  const derived = deriveAttributesV2(vector.seed);
  const actual = Object.fromEntries(
    derived.attributes.map((attribute) => [attribute.slot, attribute.value]),
  );

  for (const slot of slotOrder) {
    checks++;
    if (actual[slot] !== vector.attrs[slot]) {
      failures.push(
        `${vector.seed.slice(0, 12)}… ${slot}: ${actual[slot]} != ${vector.attrs[slot]}`,
      );
    }
  }

  checks++;
  if (derived.golden !== false) {
    failures.push(`${vector.seed.slice(0, 12)}… golden flag should be false`);
  }
}

if (failures.length > 0) {
  console.error(`traits-v2 FAIL: ${failures.length} of ${checks} checks`);
  for (const failure of failures.slice(0, 12)) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `traits-v2 OK: ${checks} checks passed (${vectors.vectors.length} seeds × ${slotOrder.length} slots + golden flag)`,
);
