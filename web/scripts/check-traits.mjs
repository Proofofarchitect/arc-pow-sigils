// Cross-check gate: web/lib/traits.ts derivation must match art/test_vectors.json
// for ALL 5 seeds × 15 slots + the golden flag.
//
// Run with tsx (which can import TypeScript from an .mjs entrypoint):
//   npm run check:traits
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveAttributes } from "../lib/traits.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../art/test_vectors.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));

const slotOrder = vectors.slot_order;
if (!Array.isArray(slotOrder) || slotOrder.length !== 15) {
  console.error("test_vectors.json is missing a 15-entry slot_order");
  process.exit(1);
}

let checks = 0;
const failures = [];

for (let i = 0; i < vectors.vectors.length; i++) {
  const vector = vectors.vectors[i];
  const derived = deriveAttributes(vector.seed);
  const actual = Object.fromEntries(
    derived.attributes.map((attribute) => [attribute.slot, attribute.value]),
  );

  for (const slot of slotOrder) {
    checks++;
    const expected = vector.attributes[slot];
    if (actual[slot] !== expected) {
      failures.push(
        `seed[${i}] ${vector.seed} slot "${slot}": expected ${JSON.stringify(
          expected,
        )} got ${JSON.stringify(actual[slot])}`,
      );
    }
  }

  checks++;
  const expectedGolden = vector.attributes.golden !== "None";
  if (derived.golden !== expectedGolden) {
    failures.push(
      `seed[${i}] ${vector.seed} golden flag: expected ${expectedGolden} got ${derived.golden}`,
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
  `PASS ${vectors.vectors.length}/${vectors.vectors.length} vectors · ${checks} checks (15 slots + golden each)`,
);
