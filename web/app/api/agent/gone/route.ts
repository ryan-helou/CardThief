import { agentValid } from "@/lib/auth";
import { markGone } from "@/lib/db";

export const dynamic = "force-dynamic";

// The Mac closes alerts that are no longer buyable (eBay listing sold/ended, local alert a week old).
// Only open ("new") deals are touched: anything Ryan marked bought or sold stays as he left it.
export async function POST(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: string; why?: string };
  if (!b.id || !b.why) return Response.json({ error: "id and why required" }, { status: 400 });
  return Response.json({ ok: true, closed: await markGone(b.id, b.why.slice(0, 200)) });
}
