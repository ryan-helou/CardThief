import { agentValid } from "@/lib/auth";
import { saveHeartbeat } from "@/lib/db";
import type { Heartbeat } from "@/lib/types";

export const dynamic = "force-dynamic";

// The Mac bot checks in every loop, so the app can say when it has gone quiet.
export async function POST(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<Heartbeat>;
  await saveHeartbeat({ ...b, at: new Date().toISOString() });
  return Response.json({ ok: true });
}
