/**
 * Lightweight, dependency-free abuse protection for the remote MCP route
 * (`/api/mcp`).
 *
 * Two in-memory sliding-window limits are enforced before the MCP handler runs:
 *   - per client IP: 60 requests / 60 s
 *   - global:        600 requests / 60 s
 *
 * Plus a request-body cap (32 KB) that rejects oversized payloads early, before
 * any JSON parsing happens downstream.
 *
 * State lives in module scope. On serverless / multi-instance deployments each
 * instance keeps its own counters, so the effective global ceiling is
 * `600 × instances`; this is a best-effort guard, not a distributed limiter.
 */

const WINDOW_MS = 60_000;
const PER_IP_LIMIT = 60;
const GLOBAL_LIMIT = 600;
const MAX_BODY_BYTES = 32 * 1024; // 32 KB

/** Triggers a one-shot sweep of idle IP buckets to bound memory growth. */
const MAX_TRACKED_IPS = 10_000;

/** Per-IP sliding windows: IP -> ascending list of request timestamps (ms). */
const ipBuckets = new Map<string, number[]>();
/** Global sliding window: ascending list of request timestamps (ms). */
let globalHits: number[] = [];

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** First hop of `x-forwarded-for`, then `x-real-ip`, then `"unknown"`. */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  return "unknown";
}

/**
 * Drop timestamps that fell out of the window. Timestamps are appended in
 * non-decreasing order, so the stale entries are always a prefix.
 */
function prune(timestamps: number[], now: number): number[] {
  let i = 0;
  const cutoff = now - WINDOW_MS;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;
  return i > 0 ? timestamps.slice(i) : timestamps;
}

/** Seconds a caller must wait before the oldest hit leaves the window. */
function retryAfterSeconds(oldest: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

function rateLimited(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Rate limit exceeded" },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
      },
    }
  );
}

function payloadTooLarge(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Request body too large" },
    }),
    {
      status: 413,
      headers: { "content-type": "application/json" },
    }
  );
}

/** Best-effort eviction of buckets that have gone empty/quiet. */
function sweepIdleBuckets(now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [ip, hits] of ipBuckets) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) {
      ipBuckets.delete(ip);
    }
  }
}

/**
 * Wrap an MCP route handler with rate limiting and a body-size cap. Returns the
 * handler's response untouched when the request is within limits, so all
 * existing MCP/JSON-RPC behaviour is preserved.
 */
export async function guardMcpRequest(
  request: Request,
  handler: (req: Request) => Promise<Response>
): Promise<Response> {
  const now = Date.now();

  // --- Global guard ---------------------------------------------------------
  globalHits = prune(globalHits, now);
  if (globalHits.length >= GLOBAL_LIMIT) {
    return rateLimited(retryAfterSeconds(globalHits[0], now));
  }

  // --- Per-IP guard ---------------------------------------------------------
  const ip = clientIp(request);
  const hits = prune(ipBuckets.get(ip) ?? [], now);
  if (hits.length >= PER_IP_LIMIT) {
    ipBuckets.set(ip, hits);
    return rateLimited(retryAfterSeconds(hits[0], now));
  }

  // Request is admitted: record it in both windows.
  globalHits.push(now);
  hits.push(now);
  ipBuckets.set(ip, hits);
  if (ipBuckets.size > MAX_TRACKED_IPS) sweepIdleBuckets(now);

  // --- Body-size guard ------------------------------------------------------
  // Cheap declared-length check first; the authoritative byte-length check
  // happens after the body is read, before it reaches JSON.parse downstream.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
      return payloadTooLarge();
    }
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!hasBody) {
    return handler(request);
  }

  const text = await request.text();
  if (byteLength(text) > MAX_BODY_BYTES) {
    return payloadTooLarge();
  }

  // Rebuild the request so the downstream handler can still read the body.
  const headers = new Headers(request.headers);
  headers.delete("content-length"); // let the runtime recompute it
  const replay = new Request(request.url, {
    method: request.method,
    headers,
    body: text.length > 0 ? text : undefined,
  });

  return handler(replay);
}
