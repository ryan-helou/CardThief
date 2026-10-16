"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Quote } from "@/lib/db";

const money = (n: number | null | undefined) => (n == null ? "–" : `${n < 0 ? "−" : ""}C$${Math.abs(Math.round(n)).toLocaleString("en-CA")}`);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

// Phone photos are 3–12 MB; the card names stay readable at 1600px, so shrink before upload.
async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

// Snap a binder, a lot or a seller's photos; the Mac reads every card and prices the whole thing.
export function QuoteTool() {
  const [photos, setPhotos] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/quotes", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r?.quotes) setQuotes(r.quotes);
  }, []);
  useEffect(() => { load(); }, [load]);
  // While a quote is being valued, check back every 8 seconds.
  const waiting = quotes.some((q) => q.status === "pending" || q.status === "working");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [waiting, load]);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError("");
    const room = 10 - photos.length;
    const next = await Promise.all([...files].slice(0, room).map(shrink));
    setPhotos((p) => [...p, ...next]);
    if (files.length > room) setError("Up to 10 photos per quote.");
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note, asking: asking || null, photos }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't send the quote.");
      setPhotos([]);
      setNote("");
      setAsking("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-3">
        <div>
          <h2 className="font-semibold">Quote a collection</h2>
          <p className="text-sm text-[var(--ink-3)]">Photograph the binder pages or the seller&apos;s photos. Mint reads every card and tells you what the lot is worth and what to offer.</p>
        </div>
        <input ref={input} type="file" accept="image/*" multiple capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <div className="flex flex-wrap gap-2">
          {photos.map((p, i) => (
            <button key={i} type="button" onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))} className="relative" aria-label="Remove photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p} alt="" className="size-16 rounded-lg object-cover" />
              <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-[var(--ink)] text-[11px] text-[var(--surface)]">×</span>
            </button>
          ))}
          {photos.length < 10 && (
            <button type="button" onClick={() => input.current?.click()} className="grid size-16 place-items-center rounded-lg border border-dashed border-[var(--rule)] text-2xl text-[var(--ink-3)]" aria-label="Add photos">+</button>
          )}
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything the photos don't show (optional): e.g. 300 cards, mostly 2000s, binder + loose" className="w-full rounded-lg border border-[var(--rule)] bg-transparent p-2 text-sm" />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--ink-2)]">Asking price</span>
          <input value={asking} onChange={(e) => setAsking(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="optional" className="w-28 rounded-lg border border-[var(--rule)] bg-transparent px-2 py-1 num" />
          <span className="text-[var(--ink-3)]">C$</span>
        </label>
        {error && <p className="text-sm text-[var(--steal)]">{error}</p>}
        <button type="button" disabled={!photos.length || busy} onClick={submit} className="w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-semibold text-white disabled:opacity-40">
          {busy ? "Sending…" : `Get a quote${photos.length ? ` (${photos.length} photo${photos.length > 1 ? "s" : ""})` : ""}`}
        </button>
      </section>

      <Pipeline quotes={quotes} />
      {quotes.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">Recent quotes</h2>
          {quotes.map((q) => <QuoteCard key={q.id} q={q} onChange={load} onDelete={async () => { await fetch(`/api/quotes?id=${q.id}`, { method: "DELETE" }); load(); }} />)}
        </section>
      )}
    </div>
  );
}

// Ready-to-send offer, in the seller's language, at the steal price (room to meet in the middle up to "max to pay").
function offerText(r: NonNullable<Quote["result"]>, fr: boolean) {
  const top = [...r.lines].sort((a, b) => b.marketCad - a.marketCad).slice(0, 3).map((x) => x.label.replace(/^\d+× /, "")).join(", ");
  return fr
    ? `Bonjour! J'ai regardé la collection${top ? ` (${top}...)` : ""}. Je pourrais vous offrir ${Math.round(r.offerSteal)}$ comptant, et je peux passer la chercher rapidement. Ça vous irait?`
    : `Hi! I went through the collection${top ? ` (${top}...)` : ""}. I could offer $${Math.round(r.offerSteal)} cash and pick it up quickly. Would that work for you?`;
}

function QuoteCard({ q, onDelete, onChange }: { q: Quote; onDelete: () => void; onChange: () => void }) {
  const r = q.result;
  const [copied, setCopied] = useState("");
  const copy = async (fr: boolean) => { if (!r) return; await navigator.clipboard.writeText(offerText(r, fr)).catch(() => {}); setCopied(fr ? "fr" : "en"); setTimeout(() => setCopied(""), 2000); };
  return (
    <article className="rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-3">
      <p className="flex items-baseline justify-between gap-2 text-xs text-[var(--ink-3)]">
        <span>{q.photoCount} photo{q.photoCount === 1 ? "" : "s"}{q.asking != null ? ` · asking ${money(q.asking)}` : ""}</span>
        <span className="flex items-center gap-2">{ago(q.createdAt)}<button type="button" onClick={onDelete} className="text-[var(--ink-3)]" aria-label="Delete quote">✕</button></span>
      </p>
      {q.source === "seller" && (
        <p className="mt-1 text-sm">
          <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">Seller</span>{" "}
          {q.contact ? <>{q.contact.name}{q.contact.city ? ` · ${q.contact.city}` : ""} · <a className="text-[var(--accent)]" href={/@/.test(q.contact.contact) ? `mailto:${q.contact.contact}` : `tel:${q.contact.contact.replace(/[^\d+]/g, "")}`}>{q.contact.contact}</a></> : null}
        </p>
      )}
      {q.note && <p className="mt-0.5 line-clamp-2 text-sm text-[var(--ink-2)]">{q.note}</p>}
      {(q.status === "pending" || q.status === "working") && <p className="mt-2 text-sm text-[var(--accent)]">{q.status === "pending" ? "Waiting for the Mac…" : "Reading every card…"}</p>}
      {q.status === "failed" && <p className="mt-2 text-sm text-[var(--steal)]">Couldn&apos;t value this one{r?.error ? `: ${r.error}` : ""}.</p>}
      {q.status === "done" && r && (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center num">
            <div><p className="font-semibold">{money(r.resale)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Resells for (net)</p></div>
            <div><p className="font-semibold text-[var(--good)]">{money(r.offerGood)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Max to pay</p></div>
            <div><p className="font-semibold text-[var(--steal)]">{money(r.offerSteal)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Steal price</p></div>
          </div>
          {r.profitAtAsking != null && (
            <p className={`mt-2 text-sm num ${r.profitAtAsking >= 0 ? "text-[var(--good)]" : "text-[var(--steal)]"}`}>
              At the asking price: {r.profitAtAsking >= 0 ? `+${money(r.profitAtAsking)} profit` : `${money(r.profitAtAsking)} (overpriced)`}
            </p>
          )}
          <p className="mt-2 text-sm text-[var(--ink-2)]">{r.summary}</p>
          {r.fakeRisk !== "low" && <p className="mt-1 text-xs text-[var(--warn)]">⚠ Fake risk {r.fakeRisk}</p>}
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-[var(--ink-3)]">{r.lines.length} cards priced{r.totalCards ? ` of ~${r.totalCards}` : ""}{r.photosRead ? ` · ${r.photosRead} photos read one by one` : ""}</summary>
            <ul className="mt-2 space-y-0.5">
              {[...r.lines].sort((a, b) => b.marketCad - a.marketCad).map((x, i) => (
                <li key={i} className="flex justify-between gap-3 text-[var(--ink-2)]">
                  <span className="min-w-0 truncate" title={x.basis}>{x.label}</span>
                  <span className="shrink-0 num">{money(x.marketCad)}</span>
                </li>
              ))}
            </ul>
            {r.askSeller && <p className="mt-2 text-[var(--ink-2)]">❓ {r.askSeller}</p>}
          </details>
          {/* An offer far below asking just insults the seller: say so instead. */}
          {q.source === "seller" && q.contact && <LeadBar q={q} onChange={onChange} />}
          {r.offerSteal > 0 && q.asking != null && r.offerSteal < q.asking * 0.4 && (
            <p className="mt-2 text-sm text-[var(--ink-3)]">Not worth an offer: a fair-to-you price is under 40% of what they ask.</p>
          )}
          {r.offerSteal > 0 && (q.asking == null || r.offerSteal >= q.asking * 0.4) && (
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => copy(q.contact?.lang !== "en")} className="flex-1 rounded-lg border border-[var(--rule)] py-1.5 text-sm">{copied === "fr" ? "Copié ✓" : `Copy offer ${money(r.offerSteal)} (FR)`}</button>
              <button type="button" onClick={() => copy(false)} className="flex-1 rounded-lg border border-[var(--rule)] py-1.5 text-sm">{copied === "en" ? "Copied ✓" : "Copy (EN)"}</button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

const STEPS: { id: Quote["lead"]; label: string }[] = [
  { id: "new", label: "New" }, { id: "contacted", label: "Contacted" }, { id: "offered", label: "Offer sent" }, { id: "bought", label: "Bought" }, { id: "passed", label: "Passed" },
];
// Where this seller stands, so no collection falls through the cracks. "Bought" asks what was paid.
function LeadBar({ q, onChange }: { q: Quote; onChange: () => void }) {
  const [paid, setPaid] = useState(q.paid != null ? String(q.paid) : "");
  const set = async (lead: Quote["lead"]) => {
    await fetch("/api/quotes", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: q.id, lead, paid: lead === "bought" && paid ? Number(paid) : null }) });
    onChange();
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {STEPS.map((s) => (
          <button key={s.id} type="button" onClick={() => set(s.id)} className={`rounded-full border px-2.5 py-1 text-xs ${q.lead === s.id ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white" : "border-[var(--rule)] text-[var(--ink-2)]"}`}>{s.label}</button>
        ))}
      </div>
      {(q.lead === "offered" || q.lead === "bought") && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--ink-2)]">Paid</span>
          <input value={paid} onChange={(e) => setPaid(e.target.value.replace(/[^\d.]/g, ""))} onBlur={() => q.lead === "bought" && paid && set("bought")} inputMode="decimal" placeholder="C$" className="w-24 rounded-lg border border-[var(--rule)] bg-transparent px-2 py-1 num" />
          {q.lead === "offered" && <button type="button" onClick={() => set("bought")} className="text-[var(--accent)]">Mark bought</button>}
        </label>
      )}
    </div>
  );
}

// Seller pipeline at a glance (only sellers whose details this device can see).
function Pipeline({ quotes }: { quotes: Quote[] }) {
  const leads = quotes.filter((q) => q.source === "seller" && q.contact);
  if (!leads.length) return null;
  const n = (l: Quote["lead"]) => leads.filter((q) => q.lead === l).length;
  const bought = leads.filter((q) => q.lead === "bought");
  const paid = bought.reduce((a, q) => a + (q.paid ?? 0), 0);
  const worth = bought.reduce((a, q) => a + (q.result?.resale ?? 0), 0);
  return (
    <section className="grid grid-cols-4 gap-2 rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-3 text-center num">
      <div><p className="font-semibold">{n("new")}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">New</p></div>
      <div><p className="font-semibold">{n("contacted") + n("offered")}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">In talks</p></div>
      <div><p className="font-semibold">{bought.length}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Bought</p></div>
      <div><p className="font-semibold text-[var(--good)]">{money(worth - paid)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Expected profit</p></div>
    </section>
  );
}
