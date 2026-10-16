import crypto from "node:crypto";

// The app itself is open (Ryan asked for no passcode). Only the local agent's
// write endpoints are gated, by a bearer token.

function hash(s: string): Buffer {
  return crypto.createHash("sha256").update(s).digest();
}

export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(hash(a), hash(b));
}

export function agentValid(header: string | null): boolean {
  const token = process.env.AGENT_TOKEN;
  if (!token || !header) return false;
  return safeEqual(header.replace(/^Bearer\s+/i, ""), token);
}

// Ryan's own devices: a one-time link sets a long-lived cookie, so sellers' contact details
// show only on his phone while the rest of the app stays open (no passcode).
export const OWNER_COOKIE = "mint_owner";
export function ownerKey(): string {
  return crypto.createHash("sha256").update(`owner:${process.env.AGENT_TOKEN || ""}`).digest("hex").slice(0, 32);
}
export function isOwner(cookieHeader: string | null): boolean {
  const v = (cookieHeader || "").split(/;\s*/).find((c) => c.startsWith(`${OWNER_COOKIE}=`))?.split("=")[1];
  return Boolean(v && process.env.AGENT_TOKEN && safeEqual(v, ownerKey()));
}
