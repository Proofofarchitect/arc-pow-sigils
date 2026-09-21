import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { attributeMap, NONE, RENDER_ORDER, type DerivedAttributes } from "./traits";

/**
 * Server-side House Card PNG compositor (sharp).
 *
 * Assets live at `web/public/traits/<slot>/<slug>[__<body>].png` where `<slot>`
 * is the spec slot name (`background`, `body`, `outfit`, `face`, `eyes`,
 * `headwear`, `tool`, `companion`, `bug`, `legendary`) and `<slug>` is the
 * kebab-case value name (`Reverse Cap 404` → `reverse-cap-404`). Head slots
 * (`face`/`eyes`/`headwear`) carry per-body variants (`<slug>__guy.png`, …);
 * resolution prefers the variant for the card's body and falls back to the flat
 * file. Source of truth and served copy are kept identical:
 * `art/assets/` ⇄ `web/public/traits/` (rebuilt from `art/svg/catalog`).
 *
 * Composition order follows `spec.json.render_order`. `None` values and files
 * that do not exist are skipped so an incomplete tree still renders gracefully.
 * All 12 backgrounds ship real art (Testnet Grid / Faucet Screen unparked in
 * session 30).
 *
 * Output size: real masters are 128×128, so we composite at native 512 (×4
 * nearest — pixel-exact) and upscale with a nearest kernel: 1024×1024 default,
 * 3072×3072 for `master` (≥3000 per OpenSea). Same seed → byte-identical output.
 */

const TRAITS_DIR = path.join(process.cwd(), "public", "traits");
const NATIVE_SIZE = 512;
const DISPLAY_SIZE = 1024;
const MASTER_SIZE = 3072;

/** Spec slot → asset directory (identical names). */
const SLOT_DIRS: Record<string, string> = {
  background: "background",
  body: "body",
  outfit: "outfit",
  face: "face",
  eyes: "eyes",
  headwear: "headwear",
  tool: "tool",
  companion: "companion",
  bug: "bug",
  legendary: "legendary",
};

const GOLDEN_DIR = "golden";

/**
 * Golden override (ANCHORS.golden.render_override): the golden full-canvas art
 * replaces the overridden slot's regular layer (house-cat -> companion,
 * fat-rat -> bug; bug is already forced to None on golden, so the skip only
 * visibly matters for the companion).
 */
const GOLDEN_OVERRIDE: Record<string, string> = {
  "house-cat": "companion",
  "fat-rat": "bug",
};

/** Slots whose layers are drawn per body (guy/girl/reptile/alien variants). */
const PER_BODY_SLOTS = new Set(["face", "eyes", "headwear"]);

/** Body value (spec) → per-body asset suffix. */
const BODY_SLUG: Record<string, string> = {
  "Builder Frame": "guy",
  "Clerk Frame": "girl",
  "Architect Frame": "reptile",
  "Shadow Frame": "alien",
};

/** `Reverse Cap 404` → `reverse-cap-404`, `Discord #dev` → `discord-dev`. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/#/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Cache headers for the image route. Minted cards are deterministic and
 * immutable -> keep them a year at the CDN; preview / not-yet-minted renders
 * change once the token mints -> short TTL (PREVIEW_CACHE_CONTROL).
 */
export const IMAGE_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=86400, immutable";

/** Short TTL for preview / not-yet-minted renders (content changes on mint). */
export const PREVIEW_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";

export function imageHeaders(
  cacheControl: string = IMAGE_CACHE_CONTROL,
): Record<string, string> {
  return {
    "Content-Type": "image/png",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  };
}

/** Resolve the asset file for a slot/value (per-body first, then flat). */
function resolveLayerFile(
  slot: string,
  value: string,
  bodyValue: string,
): string | null {
  const dir = SLOT_DIRS[slot];
  if (!dir) return null;

  const slug = slugify(value);

  // Body: canonical species files first (`body/<species>.png` — guy/girl/
  // reptile/alien, identical to `art/ai/out/bodies_v2/final`). The role-named
  // fallback (`body/clerk-frame.png`, …) may carry older archive art.
  if (slot === "body") {
    const species = BODY_SLUG[value];
    if (species) {
      const file = path.join(TRAITS_DIR, dir, `${species}.png`);
      if (existsSync(file)) return file;
    }
    const flatBody = path.join(TRAITS_DIR, dir, `${slug}.png`);
    return existsSync(flatBody) ? flatBody : null;
  }

  if (PER_BODY_SLOTS.has(slot)) {
    const bodySlug = BODY_SLUG[bodyValue];
    if (bodySlug) {
      const variant = path.join(TRAITS_DIR, dir, `${slug}__${bodySlug}.png`);
      if (existsSync(variant)) return variant;
    }
  }

  const flat = path.join(TRAITS_DIR, dir, `${slug}.png`);
  if (existsSync(flat)) return flat;

  return null;
}

export type RenderOptions = {
  /** Emit a 3072×3072 master (×6 nearest); default is 1024×1024 (×2 nearest). */
  master?: boolean;
};

/**
 * Composite a House Card PNG from the derived traits.
 *
 * Missing layer files are skipped (graceful) so an incomplete asset tree still
 * renders whatever is available; nothing is logged.
 */
export async function renderHouseCardPng(
  derived: DerivedAttributes,
  options: RenderOptions = {},
): Promise<Buffer> {
  const values = attributeMap(derived);
  const bodyValue = values["body"] ?? "";
  const composites: OverlayOptions[] = [];

  // Golden override: the overridden slot renders as the golden full-canvas art
  // (composited last) instead of its regular layer.
  const goldenEvent = derived.golden ? values["golden"] : undefined;
  const goldenOverrideSlot =
    goldenEvent && goldenEvent !== NONE ? GOLDEN_OVERRIDE[slugify(goldenEvent)] : undefined;

  for (const slot of RENDER_ORDER) {
    if (goldenOverrideSlot === slot) continue;
    const value = values[slot];
    if (!value || value === NONE) continue;

    const file = resolveLayerFile(slot, value, bodyValue);
    if (!file) continue;

    // Normalise every layer to the native canvas (128 → 512 is an exact ×4
    // nearest upscale; a future non-512 master never aborts composition).
    const input = await sharp(file)
      .resize(NATIVE_SIZE, NATIVE_SIZE, { fit: "fill", kernel: "nearest" })
      .png()
      .toBuffer();

    composites.push({ input, top: 0, left: 0 });
  }

  // Golden is a full-canvas flag overlay, composited LAST. It never coexists
  // with legendary (legendary forces golden to "None").
  if (derived.golden) {
    const event = values["golden"];
    if (event && event !== NONE) {
      const file = path.join(TRAITS_DIR, GOLDEN_DIR, `${slugify(event)}.png`);
      if (existsSync(file)) {
        const input = await sharp(file)
          .resize(NATIVE_SIZE, NATIVE_SIZE, { fit: "fill", kernel: "nearest" })
          .png()
          .toBuffer();
        composites.push({ input, top: 0, left: 0 });
      }
    }
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

  const target = options.master ? MASTER_SIZE : DISPLAY_SIZE;

  return sharp(base)
    .resize(target, target, { kernel: "nearest" })
    .png()
    .toBuffer();
}
