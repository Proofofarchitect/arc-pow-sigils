import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Cache-key canonicalization for the two expensive, deterministic render
 * endpoints (pentest W2 — finding F4: edge cache-busting cost amplification).
 *
 * The rendered payload depends on the token id and, for `/api/image`, solely on
 * the literal `?master=1`. Every other query parameter is ignored by the
 * renderer yet still creates a distinct CDN cache key, so an anonymous client
 * can force unlimited uncached origin renders (measured up to ~416 KB / ~1 s
 * per request at `?master=1`) by appending a random cache-buster.
 *
 * We 308-redirect any heavy GET/HEAD carrying ignored/extra parameters to its
 * canonical URL so the edge caches a single variant per token:
 *
 *   /api/image/1?z=1&master=1  ->  308  /api/image/1?master=1
 *   /api/image/1?master=2      ->  308  /api/image/1          (only "1" matters)
 *   /api/meta/1?z=1            ->  308  /api/meta/1           (no params allowed)
 *
 * Non-GET/HEAD methods (including CORS preflight OPTIONS) pass through
 * untouched, and `/api/mcp` / page routes are outside the matcher scope.
 */
/** Thumbnail widths the app emits with `?w=` (bounded cache-key space). */
const IMAGE_W_ALLOWED = new Set(["64", "96", "128", "192", "256", "384", "512"]);
/** Trait-set cache-buster values the app emits (`TRAITS_IMAGE_QS`). */
const IMAGE_V_ALLOWED = new Set(["1", "2", "2.1"]);

function canonicalize(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  const params = request.nextUrl.searchParams;

  const isImage =
    pathname === "/api/image" || pathname.startsWith("/api/image/");
  const isMeta = pathname === "/api/meta" || pathname.startsWith("/api/meta/");
  if (!isImage && !isMeta) return null;

  const kept = new URLSearchParams();
  let dirty = false;

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);

    if (isImage && key === "master") {
      // Only `master=1` changes render output; collapse every other value
      // (and duplicates) to "absent" so the cache key stays stable.
      if (values.length === 1 && values[0] === "1") {
        kept.set("master", "1");
      } else if (values.length > 1 || (values[0] ?? "") !== "") {
        dirty = true;
      }
      continue;
    }

    if (isImage && key === "w") {
      // Server-side thumbnail width. Bounded allowlist keeps the W2-F4
      // mitigation intact (fixed number of extra cache keys per token).
      if (values.length === 1 && IMAGE_W_ALLOWED.has(values[0])) {
        kept.set("w", values[0]);
      } else if (values.some((value) => value !== "")) {
        dirty = true;
      }
      continue;
    }

    if (isImage && key === "v") {
      // Trait-set cache-buster: preserved only for the known values so a set
      // flip refreshes art without reopening the amplification hole.
      if (values.length === 1 && IMAGE_V_ALLOWED.has(values[0])) {
        kept.set("v", values[0]);
      } else if (values.some((value) => value !== "")) {
        dirty = true;
      }
      continue;
    }

    // Any other parameter is ignored by the renderer: drop it, and mark the
    // URL non-canonical when it carried a non-empty value.
    if (values.some((value) => value !== "")) {
      dirty = true;
    }
  }

  if (!dirty) return null;

  const url = request.nextUrl.clone();
  url.search = kept.toString(); // "" clears the query entirely
  return NextResponse.redirect(url, 308);
}

export function middleware(request: NextRequest) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return NextResponse.next();
  }

  return canonicalize(request) ?? NextResponse.next();
}

export const config = {
  matcher: ["/api/image/:path*", "/api/meta/:path*"],
};
