"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Any client-side exception in a page (the
 * "Application error: a client-side exception has occurred" screen) lands
 * here instead: a branded panel with a working retry, so testers are never
 * left at a dead end. Wallet state and on-chain data are unaffected.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep the raw error in the console for debugging.
    console.error("Page error:", error);
  }, [error]);

  return (
    <main className="container">
      <div className="banner error" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong on this page</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          The page hit an unexpected error. Your wallet and cards are safe —
          nothing on-chain is affected.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <button type="button" className="primary" onClick={() => reset()}>
            Try again
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
        {error?.message ? (
          <p className="small mono" style={{ marginTop: 10, wordBreak: "break-word" }}>
            {error.message}
          </p>
        ) : null}
      </div>
    </main>
  );
}
