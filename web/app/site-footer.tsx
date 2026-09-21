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
const GITHUB_URL = "https://github.com/Proofofarchitect";

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
          <a
            className="footer-link"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Proof of Architect on GitHub (opens in a new tab)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.335-1.723-1.335-1.723-1.091-.728.083-.713.083-.713 1.205.084 1.839 1.237 1.839 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.42-1.305.762-1.605-2.665-.294-5.466-1.335-5.466-5.94 0-1.312.47-2.386 1.235-3.227-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.653-.156 1.338-.234 2.045-.234 1.02.005 2.045.138 3.003.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.841 1.234 1.915 1.234 3.227 0 4.616-2.804 5.643-5.478 5.94.43.37.814 1.1.814 2.22 0 1.602-.015 2.894-.015 3.287 0 .316.216.683.825.567C20.565 21.917 24 17.5 24 12.292 24 5.78 18.627.5 12 .5z" />
            </svg>
            <span>GitHub</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}
