import { setStatus } from "@/lib/db";
import type { Status } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: Status[] = ["new", "bought", "sold", "passed"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// Ryan marks what he did with a deal; bought/sold prices feed the test's profit tally.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { status?: Status; boughtFor?: unknown; soldFor?: unknown };
  if (!b.status || !STATUSES.includes(b.status)) return Response.json({ error: "Bad status" }, { status: 400 });
  await setStatus(decodeURIComponent(id), b.status, num(b.boughtFor), num(b.soldFor));
  return Response.json({ ok: true });
}
