import { agentValid } from "@/lib/auth";
import { outbox, setMessageResult } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  return Response.json({ items: await outbox() });
}

export async function POST(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: string; state?: string; error?: string };
  if (!b.id || (b.state !== "sent" && b.state !== "failed")) return Response.json({ error: "Bad result" }, { status: 400 });
  await setMessageResult(b.id, b.state, b.error);
  return Response.json({ ok: true });
}
