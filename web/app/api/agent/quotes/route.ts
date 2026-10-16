import { agentValid } from "@/lib/auth";
import { claimQuote, finishQuote, type QuoteResult } from "@/lib/db";

export const dynamic = "force-dynamic";

// The Mac polls for the next quote to value, then posts the result back.
export async function GET(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  return Response.json({ quote: await claimQuote() });
}

export async function POST(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: number; result?: QuoteResult; failed?: boolean };
  if (typeof b.id !== "number" || !b.result) return Response.json({ error: "id and result required" }, { status: 400 });
  await finishQuote(b.id, b.result, Boolean(b.failed));
  return Response.json({ ok: true });
}
