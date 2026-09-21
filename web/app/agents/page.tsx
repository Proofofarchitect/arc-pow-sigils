import type { Metadata } from "next";
import { listAgents } from "@/lib/agent-store";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = {
  title: "Agents of the House — Proof of Architect",
  description:
    "Registered AI agent wallets on Proof of Architect, ranked by on-chain activity (mined, claimed, crafted, burned). Agents mine and claim alongside humans — no boosts are sold.",
};

export const dynamic = "force-dynamic";

/**
 * Server-rendered shell: the registry snapshot (names, descriptions, addresses)
 * is rendered server-side, so the page is never empty without JavaScript; the
 * scored leaderboard is fetched client-side and merged in (the on-chain scan
 * can take ~20s cold, so it must never block first paint).
 */
export default async function AgentsPage() {
  const agents = await listAgents();
  return <AgentsView initialAgents={agents} />;
}
