/**
 * Self-serve agent registry storage — KV over REST, no SDK.
 *
 * An agent registration is a wallet-signed record: the agent signs a
 * "Proof of Architect — agent registration" message (see the register route)
 * and the resulting entry is persisted here so it shows up in the /api/agents
 * leaderboard. There is no GitHub PR and no paid boost — ranking stays purely
 * on-chain.
 *
 * Storage is Redis-shaped and talks to Vercel KV / Upstash over their REST
 * API directly (no `@vercel/kv` dependency): a command is a JSON array POSTed
 * to the database URL with `Authorization: Bearer <token>`. Names are resolved
 * exactly first and by suffix second, so the Vercel Upstash integration's
 * prefixed names work out of the box:
 *
 *   KV_REST_API_URL        + KV_REST_API_TOKEN          (or poa_agents_* etc.)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *
 * Data layout:
 *   poa:agent:<lowercase-addr>  STRING  JSON {name,address,description,links?,registeredAt,updatedAt}
 *   poa:agents                  SET     every registered lowercase address (index)
 *
 * Nothing here throws for reads — `listAgents` degrades to the entries it can
 * read. Writes surface a typed `AgentStoreError` so the API can answer 503.
 */

const KEY_PREFIX = "poa:agent:";
const INDEX_KEY = "poa:agents";
const REST_TIMEOUT_MS = 10_000;

/** A small labelled URL attached to an agent entry. */
export type AgentLink = {
  label: string;
  url: string;
};

/** A persisted agent registration. */
export type AgentEntry = {
  name: string;
  address: string;
  description: string;
  links?: AgentLink[];
  registeredAt: string;
  updatedAt: string;
};

/**
 * Raised when the storage backend is unreachable or answers with an error.
 * The register route maps this to a 503 "storage is being provisioned".
 */
export class AgentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoreError";
  }
}

type KvConfig = {
  url: string;
  token: string;
};

/**
 * Resolve an env var by exact name first, then by suffix. The Vercel Upstash
 * integration injects PREFIXED names derived from the resource name (e.g.
 * `poa_agents_KV_REST_API_URL`), so a plain lookup for `KV_REST_API_URL` would
 * miss them. Suffix matching is paired below (URL and TOKEN must come from the
 * same prefix, otherwise auth would fail on multi-store teams).
 */
function findEnvBySuffix(suffix: string): { key: string; value: string } | null {
  const exact = process.env[suffix];
  if (exact) return { key: suffix, value: exact };
  for (const key of Object.keys(process.env)) {
    if (!key.endsWith(`_${suffix}`)) continue;
    const value = process.env[key];
    if (value) return { key, value };
  }
  return null;
}

/** Resolve the REST credentials from exact, prefixed or Upstash-native names. */
function getConfig(): KvConfig | null {
  for (const urlSuffix of ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) {
    const url = findEnvBySuffix(urlSuffix);
    if (!url) continue;
    // Prefer the token that shares the URL's prefix (e.g. poa_agents_*).
    const prefix = url.key.endsWith(urlSuffix)
      ? url.key.slice(0, url.key.length - urlSuffix.length)
      : "";
    const tokenSuffixes = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"];
    for (const tokenSuffix of tokenSuffixes) {
      const bare = process.env[prefix + tokenSuffix];
      if (bare) return { url: url.value.replace(/\/+$/, ""), token: bare };
      const token = findEnvBySuffix(tokenSuffix);
      if (token) return { url: url.value.replace(/\/+$/, ""), token: token.value };
    }
  }
  return null;
}

/** True when KV/Upstash REST credentials are present. */
export function kvConfigured(): boolean {
  return getConfig() !== null;
}

function agentKey(address: string): string {
  return KEY_PREFIX + address.toLowerCase();
}

/**
 * Run a single Redis command over the REST API. Throws `AgentStoreError` on a
 * missing config, a network/timeout failure, a non-2xx response or an
 * `{error}` body — callers that must not fail (reads) catch it themselves.
 */
async function command(cmd: unknown[]): Promise<unknown> {
  const config = getConfig();
  if (!config) throw new AgentStoreError("KV is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cmd),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network error";
      throw new AgentStoreError(`KV request failed: ${detail}`);
    }

    if (!response.ok) {
      throw new AgentStoreError(`KV responded with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: unknown;
      error?: string;
    };
    if (payload.error) throw new AgentStoreError(payload.error);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist an agent entry and add its address to the index. Re-registering the
 * same address overwrites the previous record. Returns `true` when a record for
 * the address already existed (an update), `false` on first registration.
 */
export async function putAgent(entry: AgentEntry): Promise<boolean> {
  const address = entry.address.toLowerCase();
  const key = agentKey(address);

  const existing = await command(["GET", key]);
  const updated = existing != null;

  await command(["SET", key, JSON.stringify({ ...entry, address })]);
  await command(["SADD", INDEX_KEY, address]);

  return updated;
}

/**
 * List every registered agent. Reads the index set, then fetches each record;
 * a single unreadable/corrupt entry is skipped rather than failing the whole
 * list. Returns [] when storage is unconfigured or the index read fails.
 */
export async function listAgents(): Promise<AgentEntry[]> {
  if (!kvConfigured()) return [];

  let members: unknown;
  try {
    members = await command(["SMEMBERS", INDEX_KEY]);
  } catch {
    return [];
  }
  if (!Array.isArray(members)) return [];

  const out: AgentEntry[] = [];
  for (const raw of members) {
    if (typeof raw !== "string") continue;
    try {
      const value = await command(["GET", agentKey(raw)]);
      if (typeof value !== "string") continue;
      const parsed = JSON.parse(value) as AgentEntry;
      if (parsed && typeof parsed.address === "string") out.push(parsed);
    } catch {
      /* tolerate a single missing/corrupt record */
    }
  }
  return out;
}

/** Remove an agent record and drop it from the index (used by tests). */
export async function deleteAgent(address: string): Promise<void> {
  const lower = address.toLowerCase();
  await command(["DEL", agentKey(lower)]);
  await command(["SREM", INDEX_KEY, lower]);
}
