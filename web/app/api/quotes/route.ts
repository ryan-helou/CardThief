import { createQuote, listQuotes, quotesToday } from "@/lib/db";

export const dynamic = "force-dynamic";

// The app is open (no passcode), so quotes are capped: each one runs an AI read on Ryan's Mac.
const MAX_PER_DAY = 20;
const MAX_PHOTOS = 10;
const MAX_PHOTO_CHARS = 2_000_000; // ~1.5 MB per photo as base64; the app shrinks them before upload

export async function GET() {
  return Response.json({ quotes: await listQuotes() });
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
