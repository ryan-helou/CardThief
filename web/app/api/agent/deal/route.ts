import { agentValid } from "@/lib/auth";
import { deleteDeal, upsertDeal } from "@/lib/db";
import { sendPush } from "@/lib/push";
import type { Deal } from "@/lib/types";

export const dynamic = "force-dynamic";

const money = (n: number) => `C$${Math.round(n)}`;

function valid(d: Partial<Deal>): d is Deal {
  return (
    typeof d.id === "string" && typeof d.url === "string" && typeof d.title === "string" &&
    typeof d.price === "number" && typeof d.profit === "number" && typeof d.cost === "number" &&
    (d.tier === "steal" || d.tier === "good") && Array.isArray(d.lines)
  );
}

// The Mac bot posts each deal once it's judged. A brand-new deal buzzes the phone.
export async function POST(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const d = (await req.json().catch(() => ({}))) as Partial<Deal>;
  if (!valid(d)) return Response.json({ error: "Invalid deal" }, { status: 400 });
  const isNew = await upsertDeal(d);
  let push = null;
  if (isNew) {
    const head = d.tier === "steal" ? "🔥 Steal" : "Good deal";
    push = await sendPush({
      title: `${head} +${money(d.profit)} · ${money(d.cost)} all-in · ${d.source}`,
      body: d.title.slice(0, 120) + (d.summary ? `\n${d.summary.slice(0, 110)}` : ""),
      tag: d.id,
      url: `/#${encodeURIComponent(d.id)}`,
    });
  }
  return Response.json({ ok: true, isNew, push });
}

// Removes a deal (test entries, or a listing that turned out to be junk).
export async function DELETE(req: Request) {
  if (!agentValid(req.headers.get("authorization"))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteDeal(id);
  return Response.json({ ok: true });
}
