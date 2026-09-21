import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { UniquePiece } from "./uniques";

/**
 * renderer_uniques.ts — image for a sealed 1-of-1 piece (arc-uniques/1).
 *
 * Assets live at `web/public/uniques/<slug>.png` (1254×1254, artist PNGs).
 * Default output is the file as-is (native 1254); `?master=1` emits
 * 3762×3762 (×3 exact nearest — same rule as renderer_v2.ts masters).
 */

const DIR = path.join(process.cwd(), "public", "uniques");
const MASTER_SIZE = 3762;

export type RenderUniqueOptions = {
  /** Emit the 3762×3762 master (×3 nearest); default is native 1254×1254. */
  master?: boolean;
};

export async function renderUniquePng(
  piece: UniquePiece,
  options: RenderUniqueOptions = {},
): Promise<Buffer> {
  const png = await fs.readFile(path.join(DIR, piece.file));
  if (!options.master) return png;
  return sharp(png).resize(MASTER_SIZE, MASTER_SIZE, { kernel: "nearest" }).png().toBuffer();
}
