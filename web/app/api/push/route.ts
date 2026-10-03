import { saveSub, removeSub } from "@/lib/db";
import { pushConfigured, sendPush } from "@/lib/push";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ configured: pushConfigured(), publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!b.endpoint?.startsWith("https://") || !b.keys?.p256dh || !b.keys?.auth) {
    return Response.json({ error: "Incomplete subscription" }, { status: 400 });
  }
  const sub = { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } };
  await saveSub(sub);
  const test = await sendPush({ title: "CardThief is on", body: "Card deals will show up here.", tag: "cardthief-test" }, sub);
  return Response.json({ ok: true, test });
}

export async function DELETE(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (b.endpoint) await removeSub(b.endpoint);
  return Response.json({ ok: true });
}
