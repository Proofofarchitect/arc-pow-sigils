"use client";

import { useState } from "react";
import Image from "next/image";
import { TRAITS_IMAGE_QS } from "@/lib/traits-set";

/**
 * Mini House Card preview — the deterministic PNG from /api/image/{id}, sized
 * as a thumbnail. Used wherever cards were previously shown as bare "#id"
 * numerals (stake chips + staked list, craft picker, gacha modal) so the user
 * always sees WHICH card they are about to stake / burn.
 *
 * Falls back to the plain "#id" label if the image cannot be rendered yet
 * (race right after mint, RPC hiccup server-side, unpublished preview id).
 */
export function CardThumb({
  id,
  size = 48,
  className = "",
}: {
  id: number | bigint | string;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const text = String(id);

  if (broken) {
    return (
      <span
        className={`card-thumb card-thumb-fallback ${className}`.trim()}
        style={{ width: size, height: size, fontSize: Math.max(9, size / 4.5) }}
        aria-label={`Architector #${text}`}
      >
        #{text}
      </span>
    );
  }

  return (
    // The deterministic PNG stays the source; next/image downscales it to the
    // thumbnail size (1x/2x srcset) instead of shipping the full 1024px file.
    <Image
      className={`card-thumb ${className}`.trim()}
      src={`/api/image/${text}${TRAITS_IMAGE_QS}`}
      width={size}
      height={size}
      alt={`Architector #${text}`}
      onError={() => setBroken(true)}
    />
  );
}
