import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { attributeMap, NONE, type DerivedAttributes } from "./traits";
import { V2_RENDER_ORDER } from "./traits_v2";

/**
 * Server-side ARC-traits/2 PNG compositor (sharp) — artist layers.
 *
 * Assets live at `web/public/traits-v2/` — every layer is a full 1254×1254
 * canvas with baked placement (x=0, y=0, scale=1 per the artist's ANCHORS.json),
 * so composition is a plain top-left alpha-over in `V2_RENDER_ORDER` with NO
 * resizing, offsets or per-body resolution.
 *
 * Spec v2.1 render rules (handoff 2026-09-19):
 * - `hair` resolves through the `hair_color` slot:
 *   `hair-colors/<color>/<style>.png`, fallback `hair/<style>.png`.
 * - `nose`/`mouth` resolve through the `head` slot for heads that ship variants:
 *   `head-variants/<head>/<slot>/<value>.png` when present, else the base layer.
 *
 * Output: 1254×1254 native by default; `?master=1` emits 3762×3762 (×3 exact
 * nearest — crisp pixel-art upscale, ≥3000 for OpenSea masters).
 *
 * Same seed → byte-identical output. Missing layers are skipped gracefully.
 */

const TRAITS_DIR = path.join(process.cwd(), "public", "traits-v2");
const NATIVE_SIZE = 1254;
const MASTER_SIZE = 3762;

/** `USDC Lenses` → `usdc-lenses` (same slugify as renderer.ts). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/#/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** hair layer: color-selected variant with fallback to the base (brown) layer. */
function hairAssetFile(values: Record<string, string>, style: string): string {
  const color = values["hair_color"];
  if (color && color !== NONE) {
    const colored = path.join(
      TRAITS_DIR,
      "hair-colors",
      slugify(color),
      `${slugify(style)}.png`,
    );
    if (existsSync(colored)) return colored;
  }
  return path.join(TRAITS_DIR, "hair", `${slugify(style)}.png`);
}

/** base layer, with head-variant replacement for nose/mouth (Ice/Pale/Reptile). */
function baseAssetFile(
  slot: string,
  value: string,
  values: Record<string, string>,
): string {
  if (slot === "nose" || slot === "mouth") {
    const head = values["head"];
    if (head && head !== NONE) {
      const variant = path.join(
        TRAITS_DIR,
        "head-variants",
        slugify(head),
        slot,
        `${slugify(value)}.png`,
      );
      if (existsSync(variant)) return variant;
    }
  }
  return path.join(TRAITS_DIR, slot, `${slugify(value)}.png`);
}

export type RenderV2Options = {
  /** Emit the 3762×3762 master (×3 nearest); default is native 1254×1254. */
  master?: boolean;
};

export async function renderHouseCardPngV2(
  derived: DerivedAttributes,
  options: RenderV2Options = {},
): Promise<Buffer> {
  const values = attributeMap(derived);
  const composites: OverlayOptions[] = [];

  for (const slot of V2_RENDER_ORDER) {
    const value = values[slot];
    if (!value || value === NONE) continue;

    const file =
      slot === "hair" ? hairAssetFile(values, value) : baseAssetFile(slot, value, values);
    if (!existsSync(file)) continue;

    composites.push({ input: file, top: 0, left: 0 });
  }

  const base = await sharp({
    create: {
      width: NATIVE_SIZE,
      height: NATIVE_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  if (!options.master) return base;

  return sharp(base).resize(MASTER_SIZE, MASTER_SIZE, { kernel: "nearest" }).png().toBuffer();
}
