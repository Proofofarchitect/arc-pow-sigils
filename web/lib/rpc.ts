/**
 * RPC resilience for the public Arc endpoints.
 *
 * The Arc RPC rate-limits bursts (and sometimes answers 200 OK with a
 * JSON-RPC error body: "Request exceeds defined limit … rate limit exceeded").
 * viem does not retry those, so a refresh-spamming user sees raw errors like
 * "Could not read pending rewards: … rate limit exceeded".
 *
 * `rpcFetch` is a drop-in fetch for the viem http transport
 * (`http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() })`): it retries
 * HTTP 408/425/429/5xx AND JSON-RPC rate-limit bodies with exponential backoff
 * + jitter. `humanizeRpcError` turns any leftover rate-limit error into a
 * friendly banner message.
 *
 * Failover: `NEXT_PUBLIC_ARC_RPC_URL` may be a comma-separated endpoint list
 * (official alternates: Blockdaemon / dRPC / QuickNode — see `ARC_RPC_URLS`).
 * When the endpoint requested by the transport keeps failing after its retry
 * budget, the same JSON-RPC request is retried against the next endpoint
 * (fresh retry budget per endpoint).
 */

import { ARC_RPC_URLS } from "./arc";

const RATE_LIMIT_RE =
  /rate[\s_-]?limit|exceeds defined limit|too many requests|\b429\b/i;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 350ms, 700ms, 1.4s, 2.8s … capped at 4s, plus jitter so bursts desync. */
function backoffMs(attempt: number): number {
  return Math.min(4_000, 350 * 2 ** attempt) + Math.random() * 300;
}

/** True when an error message looks like an RPC rate-limit rejection. */
export function isRateLimitError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return RATE_LIMIT_RE.test(message);
}

/** Frindly banner text for a rate-limited RPC read; other errors pass through. */
export function humanizeRpcError(message: string): string {
  return isRateLimitError(message)
    ? "The Arc RPC is rate-limiting right now — it will retry automatically in a few seconds. Wait a moment before refreshing again."
    : message;
}

/** Normalise `RequestInfo | URL` down to a string URL. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Compare URLs ignoring trailing slashes (viem normalises URLs with one). */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * fetch with retries for the Arc RPC, plus endpoint failover. Bounded: at most
 * `maxRetries` extra attempts per endpoint (default 4) with 0.35→4s backoff;
 * the request path is otherwise unchanged. Bodies are only peeked via a
 * clone, never consumed.
 *
 * Failover applies when the requested URL is one of `ARC_RPC_URLS`: after the
 * endpoint exhausts its retry budget the request moves to the next configured
 * endpoint. When every endpoint failed, the last HTTP response is returned
 * (legacy single-endpoint behaviour); if no endpoint answered at all, the
 * last network error is thrown.
 */
export function rpcFetch(maxRetries = 4): typeof fetch {
  const retrying = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const requested = requestUrl(input);
    const targets = ARC_RPC_URLS.some((url) => sameUrl(url, requested))
      ? [requested, ...ARC_RPC_URLS.filter((url) => !sameUrl(url, requested))]
      : [requested];

    let lastError: unknown = null;
    let lastResponse: Response | null = null;

    for (const target of targets) {
      // Only rewrite the URL for failover hops; the first hop keeps the exact
      // original input (which may be a Request object).
      const targetInput = target === requested ? input : target;
      let attempt = 0;

      for (;;) {
        let response: Response;
        try {
          response = await fetch(targetInput, init);
        } catch (error) {
          // Network-level failure — retry unless we are out of attempts.
          lastError = error;
          if (attempt >= maxRetries) break; // endpoint exhausted → next
          await sleep(backoffMs(attempt++));
          continue;
        }

        lastResponse = response;

        // Peek for a 200 OK + JSON-RPC rate-limit error body (via clone only).
        let rateLimited = false;
        try {
          const text = await response.clone().text();
          rateLimited = text.includes("error") && RATE_LIMIT_RE.test(text);
        } catch {
          /* unreadable body — treat as definitive */
        }

        if (RETRYABLE_STATUS.has(response.status) || rateLimited) {
          if (attempt >= maxRetries) break; // endpoint exhausted → next
          await sleep(backoffMs(attempt++));
          continue;
        }

        return response;
      }
    }

    // Every endpoint failed: surface the last HTTP response if any (legacy
    // behaviour), otherwise the last network-level error.
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error("Arc RPC: all configured endpoints failed");
  };
  return retrying as typeof fetch;
}
