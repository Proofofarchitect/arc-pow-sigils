import type { Metadata } from "next";
import Link from "next/link";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";
import "./poa/variants/03-with-characters.css";
import { SiteFooter } from "./site-footer";
import WalletCorner from "./wallet-corner";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// Brand fonts — same pairing as the pre-launch landing:
// Space Grotesk (UI/headings) + IBM Plex Mono (micro-labels, numbers, addresses).
const sans = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  keywords: [
    "PoW NFT",
    "proof of work NFT",
    "Arc Chain",
    "Arc network",
    "Circle L1",
    "USDC",
    "keccak256 mining",
    "browser mining",
    "NFT collection",
    "Proof of Architect",
  ],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
  alternates: {
    types: {
      "application/rss+xml": "/changelog.xml",
    },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
    },
    {
      "@type": "WebSite",
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      name: `${SITE_NAME} Miner`,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      url: `${SITE_URL}/mine`,
      description:
        "Browser-based proof-of-work miner and NFT minter for the Proof of Architect collection. Grinds a keccak-256 nonce and submits it to the on-chain mint function; art is rendered as Architectors derived from the winning hash.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {/* Self-hosted pixel fonts render above the fold (h1/h2/labels):
            preload the two 400-weight faces so first paint has them ready.
            React hoists these into <head>. */}
        <link
          rel="preload"
          href="/poa/fonts/press-start-2p-400.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/poa/fonts/silkscreen-400.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <header className="site-header">
          <div className="container header-inner">
            <Link href="/" className="brand" aria-label="Proof of Architect — home">
              <span className="arch-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="brand-text">Proof of Architect</span>
            </Link>
            <nav className="site-nav" aria-label="Primary navigation">
              <Link href="/">Collection</Link>
              <Link href="/mine">Mine</Link>
              <Link href="/stake">Stake</Link>
              <Link href="/craft">Craft</Link>
              <Link href="/claim">Claim</Link>
              <Link href="/points">Points</Link>
              <Link href="/agents">Agents</Link>
            </nav>
            <div className="header-action">
              <Link href="/mine" className="button button-primary button-sm">
                Start mining
              </Link>
              <WalletCorner />
            </div>
          </div>
        </header>
        {children}
        <SiteFooter />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
