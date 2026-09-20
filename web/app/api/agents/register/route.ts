import { NextResponse } from "next/server";
import { isAddress, verifyMessage } from "viem";
import {
  AgentStoreError,
  kvConfigured,
  putAgent,
  type AgentEntry,
  type AgentLink,
} from "@/lib/agent-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agents/register — self-serve, GitHub-free agent registration.
 *
 * The agent signs a canonical EIP-191 (`personal_sign`) message with its wallet
 * and POSTs the body below. We rebuild the same message from the submitted
 * fields, verify the signature with viem, then persist the record to KV (see
 * lib/agent-store.ts); the entry then appears in the /api/agents leaderboard.
 *
 * Body: { name, address, description, links?, message, signature }
 *
 * The signed message is:
 *
 *   Proof of Architect — agent registration
 *   address: <lowercase 0x…>
 *   name: <name>
 *   timestamp: <unix seconds>
 *
 * Responses: 200 {ok,address,updated} · 400 invalid · 401 bad signature ·
 * 429 rate limited · 503 storage not configured.
 */

const PROVISIONING_ERROR =
  "Registration storage is being provisioned — try again shortly.";
const SIGNATURE_ERROR = "Signature does not match the address.";
const RATE_LIMIT_ERROR =
  "Too many registration attempts — try again in a minute.";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

const TIMESTAMP_MAX_AGE_S = 86_400; // 24h in the past
const TIMESTAMP_FUTURE_S = 300; // 5min of clock skew allowed

// Best-effort per-instance throttle. On Vercel each instance keeps its own
// Map, so this is a soft limit — good enough to blunt scripted spam.
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function bad(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * The exact signed payload. Built identically on the client and here so a
 * signature over a tampered field can never verify.
 */
function buildMessage(address: string, name: string, timestamp: number): string {
  return [
    "Proof of Architect — agent registration",
    `address: ${address}`,
    `name: ${name}`,
    `timestamp: ${timestamp}`,
  ].join("\n");
}

/** true for a valid optional links array; null means "present but invalid". */
function parseLinks(value: unknown): AgentLink[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 5) return null;
  const out: AgentLink[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { label, url } = item as Record<string, unknown>;
    if (typeof label !== "string" || label.length < 1 || label.length > 24) {
      return null;
    }
    if (typeof url !== "string" || url.length > 200 || !/^https?:\/\//i.test(url)) {
      return null;
    }
    out.push({ label, url });
  }
  return out;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (rateLimited(clientIp(request))) {
    return NextResponse.json({ error: RATE_LIMIT_ERROR }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return bad("Request body must be a JSON object.");
  }

  const { name, address, description, links, message, signature } =
    body as Record<string, unknown>;

  // --- name: 2..48 chars, no line breaks (it is embedded in the message) ----
  if (
    typeof name !== "string" ||
    name.length < 2 ||
    name.length > 48 ||
    /[\r\n]/.test(name)
  ) {
    return bad("name must be 2–48 characters.");
  }

  // --- description: 1..280 chars -------------------------------------------
  if (
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 280
  ) {
    return bad("description must be 1–280 characters.");
  }

  // --- links: optional, ≤5 labelled http(s) URLs ---------------------------
  const parsedLinks = parseLinks(links);
  if (parsedLinks === null) {
    return bad("links must be up to 5 { label, url } entries with http(s) URLs.");
  }

  // --- address: valid EVM address ------------------------------------------
  if (typeof address !== "string" || !isAddress(address, { strict: false })) {
    return bad("A valid address is required.");
  }
  const lower = address.toLowerCase();

  // --- message / signature shape -------------------------------------------
  if (typeof message !== "string" || message.length === 0 || message.length > 1000) {
    return bad("message is required.");
  }
  if (
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(signature)
  ) {
    return bad("signature is required.");
  }

  // --- message must commit to this address / name / timestamp --------------
  if (!message.includes(`address: ${lower}`)) {
    return bad("Message is missing the signing address.");
  }
  if (!message.includes(`name: ${name}`)) {
    return bad("Message name does not match the submitted name.");
  }
  const tsMatch = /^timestamp:\s*(\d+)\s*$/m.exec(message);
  if (!tsMatch) {
    return bad("Message is missing a timestamp.");
  }
  const timestamp = Number(tsMatch[1]);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + TIMESTAMP_FUTURE_S ||
    timestamp < now - TIMESTAMP_MAX_AGE_S
  ) {
    return bad("Message timestamp is outside the accepted window.");
  }
  // Rebuild canonically and require an exact match, so no signed field can be
  // swapped for a different one (e.g. injected newlines).
  if (message.trim() !== buildMessage(lower, name, timestamp).trim()) {
    return bad("Message does not match the expected registration format.");
  }

  // --- signature must be from the claimed address --------------------------
  let valid = false;
  try {
    valid = await verifyMessage({
      address: lower as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: SIGNATURE_ERROR }, { status: 401 });
  }

  // --- storage must be provisioned before we can persist -------------------
  if (!kvConfigured()) {
    return NextResponse.json({ error: PROVISIONING_ERROR }, { status: 503 });
  }

  const nowIso = new Date().toISOString();
  const entry: AgentEntry = {
    name,
    address: lower,
    description,
    ...(parsedLinks ? { links: parsedLinks } : {}),
    registeredAt: nowIso,
    updatedAt: nowIso,
  };

  try {
    const updated = await putAgent(entry);
    return NextResponse.json({ ok: true, address: lower, updated });
  } catch (error) {
    if (error instanceof AgentStoreError) {
      return NextResponse.json({ error: PROVISIONING_ERROR }, { status: 503 });
    }
    return NextResponse.json(
      { error: "Unable to save the registration." },
      { status: 500 },
    );
  }
}
