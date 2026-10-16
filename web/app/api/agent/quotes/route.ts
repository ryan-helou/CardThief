import { agentValid } from "@/lib/auth";
import { claimQuote, finishQuote, type QuoteResult } from "@/lib/db";
import { sendPush } from "@/lib/push";

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
  const q = await finishQuote(b.id, b.result, Boolean(b.failed));
  // A seller sent their collection: buzz Ryan with Mint's numbers so he can answer fast.
  if (q?.source === "seller" && !b.failed) {
    const c = q.contact;
    await sendPush({
      title: `New collection: ${c?.name || "a seller"}${c?.city ? ` (${c.city})` : ""}`,
      body: `Resells ~C$${Math.round(b.result.resale)} · pay up to C$${Math.round(b.result.offerGood)}${q.asking != null ? ` · asks C$${Math.round(q.asking)}` : ""}\n${b.result.summary.slice(0, 110)}`,
      tag: `quote-${b.id}`,
      url: "/?tab=quote",
      urgent: true,
    });
  }
  return Response.json({ ok: true });
}
