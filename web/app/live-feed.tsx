"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { TRAITS_IMAGE_QS } from "@/lib/traits-set";

/**
 * Live claims & mints strip — polls /api/recent (Blockscout-backed, server-
 * cached) every 20s and renders the latest events as a single horizontal row
 * of House Card thumbnails. Oldest first, so fresh events land on the right
 * end; the row sticks to its right end — once it overflows the band, the
 * leftmost (oldest) card slides out of view.
 */

type RecentEvent = {
  kind: "claim" | "mint";
  tokenId: number;
  miner: string;
  codeHash?: string;
  bits?: number;
  paid?: string;
  txHash: string;
  timestamp: string;
};

const POLL_MS = 20_000;

function shortAddress(address: string): string {
  if (!address || address.length < 12) return address || "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function timeAgo(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function tokenLabel(id: number): string {
  return `#${String(id).padStart(4, "0")}`;
}

export default function LiveFeed() {
  const [events, setEvents] = useState<RecentEvent[] | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/recent", { cache: "no-store" });
        const json = (await response.json()) as { events?: RecentEvent[] };
        if (!cancelled) setEvents(json.events ?? []);
      } catch {
        if (!cancelled) setEvents((previous) => previous ?? []);
      }
    }

    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // /api/recent returns newest-first; flip it so the row reads left → right in
  // chronological order and new events appear on the right edge.
  const rendered = useMemo(() => [...(events ?? [])].reverse(), [events]);

  // Follow the tail: keep the right end (freshest cards) in view. Older cards
  // drift off the left edge once the row is wider than the band.
  useEffect(() => {
    const node = stripRef.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [rendered]);

  return (
    <section className="live-band" aria-label="Latest claims and mints">
      <div className="live-head">
        <span className="live-title">
          <span className="live-dot" aria-hidden="true" />
          Latest claims &amp; mints
        </span>
        {rendered.length > 0 && (
          <span className="live-count">
            {rendered.length} event{rendered.length === 1 ? "" : "s"} · live
          </span>
        )}
      </div>

      {events === null ? (
        <div className="live-empty">Loading activity…</div>
      ) : rendered.length === 0 ? (
        <div className="live-empty">
          No claims or mints yet — the first one will appear here live.
        </div>
      ) : (
        <div className="live-items" ref={stripRef}>
          {rendered.map((event) => (
            <a
              className="live-item"
              key={`${event.txHash}-${event.tokenId}-${event.kind}`}
              href={`/token/${event.tokenId}`}
              title={`${event.txHash} · ${event.timestamp}`}
            >
              <Image
                className="live-thumb"
                src={`/api/image/${event.tokenId}${TRAITS_IMAGE_QS}`}
                alt={`Architector ${tokenLabel(event.tokenId)}`}
                width={48}
                height={48}
              />
              <span className="live-meta">
                <span className="live-line">
                  <span className={`live-kind live-kind-${event.kind}`}>
                    {event.kind === "claim" ? "Claim" : "Mint"}
                  </span>
                  <span className="live-token">{tokenLabel(event.tokenId)}</span>
                </span>
                <span className="live-line live-line-sub">
                  <span className="live-addr">{shortAddress(event.miner)}</span>
                  {event.kind === "mint" && event.bits !== undefined && (
                    <span className="live-bits">{event.bits} bits</span>
                  )}
                  <span className="live-time">{timeAgo(event.timestamp)}</span>
                </span>
              </span>
            </a>
          ))}
        </div>
      )}

      <div className="live-note">
        Mined cards are freely transferable from wave 1 — the wave-5 lock
        applies only to the 42 claim (whitelist) cards.
      </div>
    </section>
  );
}
