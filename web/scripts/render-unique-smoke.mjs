// Smoke: render sealed 1-of-1 pieces through the real server renderer
// (lib/renderer_uniques.ts) — display 1254 + master 3762 — and assert sizes.
//
//   npm run render:uniques            # writes /tmp/opencode/uniques-smoke/*.png
//
// Needs no UNIQUES_IDS: resolves pieces directly from the registry, so it works
// in any environment and never touches the sealed id list.
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

import { renderUniquePng } from "../lib/renderer_uniques.ts";
import { UNIQUE_PIECES } from "../lib/uniques.ts";

const OUT = "/tmp/opencode/uniques-smoke";
const SAMPLE = ["p01-visionary", "p11-satoshi", "p17-cosmic"];

mkdirSync(OUT, { recursive: true });

let checks = 0;
const failures = [];

for (const slug of SAMPLE) {
  const piece = UNIQUE_PIECES.find((p) => p.slug === slug);
  if (!piece) {
    failures.push(`piece not found in registry: ${slug}`);
    continue;
  }

  for (const master of [false, true]) {
    const png = await renderUniquePng(piece, { master });
    const meta = await sharp(png).metadata();
    const expected = master ? 3762 : 1254;
    checks++;
    if (meta.width !== expected || meta.height !== expected) {
      failures.push(`${slug}${master ? " master" : ""}: ${meta.width}×${meta.height} != ${expected}`);
    }
    const file = `${OUT}/${slug}${master ? "-master" : ""}.png`;
    writeFileSync(file, png);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`FAIL — ${failures.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`OK — ${checks} checks passed (${SAMPLE.length} pieces × display+master), out: ${OUT}`);
