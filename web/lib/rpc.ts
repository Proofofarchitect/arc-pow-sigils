/**
 * RPC resilience for the public Arc endpoint.
 *
 * The Arc testnet RPC rate-limits bursts (and sometimes answers 200 OK with a
 * JSON-RPC error body: "Request exceeds defined limit … rate limit exceeded").
 * viem does not retry those, so a refresh-spamming user sees raw errors like
 * "Could not read pending rewards: … rate limit exceeded".
 *
 * `rpcFetch` is a drop-in fetch for the viem http transport
 * (`http(ARC_RPC_URL, { timeout: 15_000, fetchFn: rpcFetch() })`): it retries
 * HTTP 408/425/429/5xx AND JSON-RPC rate-limit bodies with exponential backoff
 * + jitter. `humanizeRpcError` turns any leftover rate-limit error into a
 * friendly banner message.
 */

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

/**
 * fetch with retries for the Arc RPC. Bounded: at most `maxRetries` extra
 * attempts (default 4) with 0.35→4s backoff; the request path is otherwise
 * unchanged. Bodies are only peeked via a clone, never consumed.
 */
export function rpcFetch(maxRetries = 4): typeof fetch {
  const retrying = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        // Network-level failure — retry unless we are out of attempts.
        if (attempt >= maxRetries) throw error;
        await sleep(backoffMs(attempt++));
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt++));
        continue;
      }

      // 200 OK + JSON-RPC rate-limit error body.
      if (attempt < maxRetries) {
        try {
          const text = await response.clone().text();
          if (text.includes("error") && RATE_LIMIT_RE.test(text)) {
            await sleep(backoffMs(attempt++));
            continue;
          }
        } catch {
          /* unreadable body — return as-is */
        }
      }

      return response;
    }
  };
  return retrying as typeof fetch;
}
