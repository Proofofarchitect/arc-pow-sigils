import { SITE_NAME } from "@/lib/site";

/**
 * Site-wide footer: official links rendered as accessible buttons.
 *
 * Best practices applied:
 * - real <a> elements (keyboard + middle-click work), opened in a new tab with
 *   rel="noopener noreferrer";
 * - aria-label states the destination and the "(opens in a new tab)" behavior;
 * - icons are aria-hidden decoration; ≥44px touch targets and a visible
 *   :focus-visible ring are defined in globals.css (.footer-link).
 */

const GITBOOK_URL = "https://proofofarchitect.gitbook.io/proof-of-architect/";
const X_URL = "https://x.com/proof_of_arc";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer-inner">
        <p className="muted small footer-note">
          © {new Date().getFullYear()} {SITE_NAME} — proof-of-work Architectors on
          Arc.
        </p>
        <nav className="footer-links" aria-label="Official links">
          <a
            className="footer-link"
            href={GITBOOK_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Documentation on GitBook (opens in a new tab)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>Docs on GitBook</span>
          </a>
          <a
            className="footer-link"
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Proof of Architect on X, @proof_of_arc (opens in a new tab)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>Follow on X</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}
