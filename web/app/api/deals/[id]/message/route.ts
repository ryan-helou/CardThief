import { queueMessage } from "@/lib/db";

export const dynamic = "force-dynamic";

// Ryan tapped Send: queue the text; the Mac bot sends it from his Marketplace login.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 600) : "";
  if (!text) return Response.json({ error: "Message is empty" }, { status: 400 });
  await queueMessage(decodeURIComponent(id), text);
  return Response.json({ ok: true });
}
