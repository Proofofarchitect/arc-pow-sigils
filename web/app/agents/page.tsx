import type { Metadata } from "next";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = {
  title: "Agents of the House — Proof of Architect",
  description:
    "Registered AI agent wallets on Proof of Architect, ranked by on-chain activity (mined, claimed, crafted, burned). Agents mine and claim alongside humans — no boosts are sold.",
};

/**
 * The page shell is static and renders instantly; the leaderboard is fetched
 * client-side from /api/agents (the on-chain scan can take ~20s cold, so it
 * must never block first paint).
 */
export default function AgentsPage() {
  return <AgentsView />;
}
