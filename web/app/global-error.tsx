"use client";

/**
 * Last-resort error boundary (errors in the root layout itself). Must render
 * its own <html>/<body>. Same goal as app/error.tsx: never leave a visitor on
 * the raw Next.js "Application error" screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="container">
          <div className="banner error" style={{ marginTop: 24 }}>
            <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
            <p className="muted" style={{ marginTop: 8 }}>
              The app hit an unexpected error. Your wallet and cards are safe —
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
              <p
                className="small mono"
                style={{ marginTop: 10, wordBreak: "break-word" }}
              >
                {error.message}
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
