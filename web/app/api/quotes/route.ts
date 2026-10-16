import { isOwner } from "@/lib/auth";
import { createQuote, deleteQuote, listQuotes, quotesToday, setLead, type Lead } from "@/lib/db";

export const dynamic = "force-dynamic";

// The app is open (no passcode), so quotes are capped: each one runs an AI read on Ryan's Mac.
const MAX_PER_DAY = 20;
const MAX_PHOTOS = 10;
const MAX_PHOTO_CHARS = 2_000_000; // ~1.5 MB per photo as base64; the app shrinks them before upload

export async function GET(req: Request) {
  return Response.json({ quotes: await listQuotes(isOwner(req.headers.get("cookie"))) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { note?: string; asking?: number | string | null; photos?: string[] };
  const photos = Array.isArray(body.photos) ? body.photos.filter((p) => typeof p === "string" && p.startsWith("data:image/")) : [];
  if (!photos.length) return Response.json({ error: "Add at least one photo." }, { status: 400 });
  if (photos.length > MAX_PHOTOS) return Response.json({ error: `Up to ${MAX_PHOTOS} photos per quote.` }, { status: 400 });
  if (photos.some((p) => p.length > MAX_PHOTO_CHARS)) return Response.json({ error: "A photo is too large." }, { status: 413 });
  if ((await quotesToday()) >= MAX_PER_DAY) return Response.json({ error: `Daily limit of ${MAX_PER_DAY} quotes reached.` }, { status: 429 });
  const asking = body.asking == null || body.asking === "" ? null : Number(body.asking);
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : null;
  const id = await createQuote(note, Number.isFinite(asking) ? asking : null, photos);
  return Response.json({ ok: true, id });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return Response.json({ error: "id required" }, { status: 400 });
  await deleteQuote(id);
  return Response.json({ ok: true });
}

// Lead pipeline for seller submissions: Ryan's own device only.
const LEADS: Lead[] = ["new", "contacted", "offered", "bought", "passed"];
export async function PATCH(req: Request) {
  if (!isOwner(req.headers.get("cookie"))) return Response.json({ error: "Open your owner link on this device first." }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { id?: number; lead?: Lead; paid?: number | null };
  if (typeof b.id !== "number" || !b.lead || !LEADS.includes(b.lead)) return Response.json({ error: "id and lead required" }, { status: 400 });
  await setLead(b.id, b.lead, typeof b.paid === "number" && Number.isFinite(b.paid) ? b.paid : null);
  return Response.json({ ok: true });
}
