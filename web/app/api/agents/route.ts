import { NextResponse } from "next/server";
import { fetchAllPoints, type WalletPoints } from "@/lib/points";
import { kvConfigured, listAgents } from "@/lib/agent-store";
import registryJson from "@/lib/agents-registry.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold scans walk the chain in 10k-block chunks under the RPC rate limit.
export const maxDuration = 60;

const CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=60";
const DOMAIN = "proofofarchitect.agents/1";

/**
 * A registry link is a small labelled URL an operator can attach to their
 * agent entry (site, source repo, docs, profile).
 */
type AgentLink = {
  label: string;
  url: string;
};

/**
 * A single registry entry. Seeded entries are a PR to lib/agents-registry.json;
 * self-serve entries are wallet-signed and stored in KV (lib/agent-store.ts).
 * There is no paid boost — ranking is purely on-chain.
 */
type RegistryAgent = {
  name: string;
  address: string;
  description: string;
  links?: AgentLink[];
};

/**
 * Explicit shape of the imported JSON. The file ships with an empty `agents`
 * array (which TS would otherwise infer as `never[]`), so we cast to the
 * declared contract instead of relying on inference.
 */
type Registry = {
  version: number;
  note: string;
  agents: RegistryAgent[];
};

/** Where an entry came from: the committed seed file or self-serve KV. */
type AgentSource = "seed" | "self-serve";

type MergedAgent = RegistryAgent & { source: AgentSource };

const registry = registryJson as Registry;

/**
 * GET /api/agents — AI agent registry + activity leaderboard.
 *
 * Seeded registry entries (lib/agents-registry.json) are the base; self-serve
 * entries registered via POST /api/agents/register are merged in from KV. When
 * the same address appears in both, the self-serve record wins.
 *
 * Returns the merged registry (name / address / description / links / source)
 * plus a leaderboard where every agent is merged with its on-chain points from
 * fetchAllPoints(). Only registered wallets appear; a registered address with
 * no activity is reported with zeroes. Sorted by points desc.
 *
 * When the merged registry is empty the on-chain scan is skipped and an empty
 * leaderboard is returned straight away (see the early return below).
 */
export async function GET() {
  // Self-serve records live in KV; when storage is unconfigured (or its read
  // fails) we simply fall back to the seed file. Reads must never throw here.
  const kvAgents = kvConfigured() ? await listAgents().catch(() => []) : [];

  // Seed file is the base; KV entries are added and win on address collision.
  const merged = new Map<string, MergedAgent>();
  for (const agent of registry.agents) {
    merged.set(agent.address.toLowerCase(), { ...agent, source: "seed" });
  }
  for (const agent of kvAgents) {
    merged.set(agent.address.toLowerCase(), {
      name: agent.name,
      address: agent.address,
      description: agent.description,
      ...(agent.links ? { links: agent.links } : {}),
      source: "self-serve",
    });
  }

  // Empty (merged) registry: there is nothing to rank, so skip the on-chain
  // scan entirely. fetchAllPoints() walks the chain in 10k-block chunks under
  // the RPC rate limit (up to ~60s), and with zero registered agents its result
  // is discarded anyway — running it would only burn RPC quota and force a
  // STALE response. Return the empty shape immediately.
  if (merged.size === 0) {
    return NextResponse.json(
      {
        domain: DOMAIN,
        updatedAt: new Date().toISOString(),
        registry: {
          version: registry.version,
          agents: [],
        },
        leaderboard: [],
      },
      {
        headers: {
          "Cache-Control": CACHE_CONTROL,
        },
      },
    );
  }

  try {
    const snapshot = await fetchAllPoints();

    const byAddress = new Map<string, WalletPoints>();
    for (const wallet of snapshot.wallets) {
      byAddress.set(wallet.address.toLowerCase(), wallet);
    }

    const agents = [...merged.values()];

    const leaderboard = agents
      .map((agent) => {
        const points = byAddress.get(agent.address.toLowerCase());
        return {
          address: agent.address,
          name: agent.name,
          description: agent.description,
          ...(agent.links ? { links: agent.links } : {}),
          mined: points?.mined ?? 0,
          claimed: points?.claimed ?? 0,
          forged: points?.forged ?? 0,
          burned: points?.burned ?? 0,
          points: points?.points ?? 0,
          source: agent.source,
        };
      })
      .sort((a, b) => b.points - a.points);

    return NextResponse.json(
      {
        domain: DOMAIN,
        updatedAt: new Date().toISOString(),
        registry: {
          version: registry.version,
          agents: agents.map((agent) => ({
            name: agent.name,
            address: agent.address,
            description: agent.description,
            ...(agent.links ? { links: agent.links } : {}),
            source: agent.source,
          })),
        },
        leaderboard,
      },
      {
        headers: {
          "Cache-Control": CACHE_CONTROL,
        },
      },
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to load agent leaderboard" },
      { status: 502 },
    );
  }
}
