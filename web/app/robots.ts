import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * robots.txt — policy: maximum visibility, everyone welcome.
 *
 * Owner decision (16.09.2026): no blocks at all — the launch site is
 * short-lived and every crawler (AI, search engines, even SEO tooling) is
 * explicitly welcome. The AI user-agent list below is redundant with the
 * `*` rule but documents the crawlers we care about and acts as a positive
 * allow signal.
 *
 * Crawler roles (Sep 2026):
 *  - OpenAI:  OAI-SearchBot (ChatGPT search), GPTBot (training),
 *             ChatGPT-User (user-initiated fetches), OAI-AdsBot (ad validation)
 *  - Anthropic: Claude-SearchBot (search), Claude-User (user fetches), ClaudeBot (training)
 *  - Perplexity: PerplexityBot (search), Perplexity-User (user fetches)
 *  - Google: Googlebot (Search / AI Overviews), Google-Agent (signed agent-browsing UA),
 *            Google-CloudVertexBot (Vertex AI grounding), GoogleOther (+ -Image/-Video,
 *            other product crawlers). Note: Google-Extended is a *control token*, not a
 *            user-agent — it is listed below only as an explicit allow signal.
 *  - Others: Bingbot (Copilot), Applebot(-Extended), meta-externalagent (Meta AI),
 *            DuckAssistBot, Amazonbot, YandexBot, cohere-ai, YouBot, MistralAI-User
 */
const AI_BOTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "OAI-AdsBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Googlebot",
  "Google-Extended",
  "Google-Agent",
  "Google-CloudVertexBot",
  "GoogleOther",
  "GoogleOther-Image",
  "GoogleOther-Video",
  "Bingbot",
  "Applebot",
  "Applebot-Extended",
  "meta-externalagent",
  "DuckAssistBot",
  "Amazonbot",
  "YandexBot",
  "cohere-ai",
  "YouBot",
  "MistralAI-User",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      { userAgent: AI_BOTS, allow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
