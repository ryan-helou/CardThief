import { createQuote, quotesToday } from "@/lib/db";

export const dynamic = "force-dynamic";

// Public "sell us your cards" form. Each submission runs an AI read on Ryan's Mac, so it's capped,
// and a hidden field catches simple bots.
const MAX_PER_DAY = 30;
const clean = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (clean(b.website, 200)) return Response.json({ ok: true }); // honeypot: pretend success
  const photos = Array.isArray(b.photos) ? (b.photos as unknown[]).filter((p): p is string => typeof p === "string" && p.startsWith("data:image/")) : [];
  const name = clean(b.name, 80), contact = clean(b.contact, 120), city = clean(b.city, 80);
  const lang = b.lang === "en" ? "en" : "fr";
  if (!photos.length || photos.length > 10 || photos.some((p) => p.length > 2_000_000)) return Response.json({ error: lang === "fr" ? "Ajoutez de 1 à 10 photos." : "Add 1 to 10 photos." }, { status: 400 });
  if (!name || !contact) return Response.json({ error: lang === "fr" ? "Votre nom et un moyen de vous joindre sont requis." : "Your name and a way to reach you are required." }, { status: 400 });
  if (b.consent !== true) return Response.json({ error: lang === "fr" ? "Cochez la case pour qu'on puisse vous répondre." : "Tick the box so we can reply." }, { status: 400 });
  if ((await quotesToday("seller")) >= MAX_PER_DAY) return Response.json({ error: lang === "fr" ? "Trop de demandes aujourd'hui, réessayez demain." : "Too many requests today, please try tomorrow." }, { status: 429 });
  const askingN = Number(b.asking);
  const note = [clean(b.message, 800), clean(b.count, 40) ? `${lang === "fr" ? "Nombre de cartes" : "Card count"}: ${clean(b.count, 40)}` : ""].filter(Boolean).join("\n");
  await createQuote(note || null, b.asking != null && b.asking !== "" && Number.isFinite(askingN) ? askingN : null, photos, "seller", { name, contact, city, lang });
  return Response.json({ ok: true });
}
