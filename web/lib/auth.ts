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
