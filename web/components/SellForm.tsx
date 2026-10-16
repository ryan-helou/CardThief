"use client";
import { useRef, useState } from "react";

const T = {
  fr: {
    title: "Vendez vos cartes Pokémon",
    lead: "Une vieille collection, un classeur, des cartes gradées? Envoyez des photos et recevez une offre en argent comptant, habituellement en moins de 24 h. On se déplace dans la région de Montréal et Laval.",
    how: ["Prenez des photos claires des cartes (pages du classeur, piles, cartes gradées).", "Dites-nous comment vous joindre.", "On regarde chaque carte et on vous fait une offre. Aucune obligation."],
    photos: "Photos (1 à 10)", add: "Ajouter des photos", name: "Votre prénom", contact: "Téléphone ou courriel", city: "Ville", count: "Nombre de cartes (approx.)",
    asking: "Avez-vous un prix en tête? (optionnel)", message: "Autre chose à savoir? (optionnel)", consent: "J'accepte d'être contacté au sujet de mes cartes.",
    send: "Recevoir une offre", sending: "Envoi…", done: "Merci! On regarde vos cartes et on vous revient avec une offre, habituellement en moins de 24 h.", again: "Envoyer une autre collection",
    privacy: "Vos coordonnées servent seulement à vous répondre au sujet de vos cartes. Elles ne sont jamais partagées.", other: "English",
  },
  en: {
    title: "Sell your Pokémon cards",
    lead: "An old collection, a binder, graded cards? Send photos and get a cash offer, usually within 24 hours. We come to you around Montréal and Laval.",
    how: ["Take clear photos of the cards (binder pages, piles, graded cards).", "Tell us how to reach you.", "We look at every card and make you an offer. No obligation."],
    photos: "Photos (1 to 10)", add: "Add photos", name: "Your first name", contact: "Phone or email", city: "City", count: "Number of cards (approx.)",
    asking: "Do you have a price in mind? (optional)", message: "Anything else we should know? (optional)", consent: "I agree to be contacted about my cards.",
    send: "Get an offer", sending: "Sending…", done: "Thanks! We're looking at your cards and will get back to you with an offer, usually within 24 hours.", again: "Send another collection",
    privacy: "Your details are only used to reply about your cards. They are never shared.", other: "Français",
  },
};

async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

export function SellForm() {
  const [lang, setLang] = useState<"fr" | "en">("fr");
  const t = T[lang];
  const [photos, setPhotos] = useState<string[]>([]);
  const [f, setF] = useState({ name: "", contact: "", city: "", count: "", asking: "", message: "", website: "" });
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"form" | "sending" | "done">("form");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const next = await Promise.all([...files].slice(0, 10 - photos.length).map(shrink));
    setPhotos((p) => [...p, ...next]);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setState("sending");
    const r = await fetch("/api/sell", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, photos, consent, lang }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(j.error || "Error"); setState("form"); return; }
    setState("done");
  }

  const field = "w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-3 py-2";
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
        <button type="button" onClick={() => setLang(lang === "fr" ? "en" : "fr")} className="shrink-0 text-sm text-[var(--accent)]">{t.other}</button>
      </div>
      <p className="text-[var(--ink-2)]">{t.lead}</p>
      {state === "done" ? (
        <div className="space-y-3 rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-4">
          <p className="font-medium">{t.done}</p>
          <button type="button" className="text-sm text-[var(--accent)]" onClick={() => { setPhotos([]); setF({ name: f.name, contact: f.contact, city: f.city, count: "", asking: "", message: "", website: "" }); setState("form"); }}>{t.again}</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--ink-2)]">{t.how.map((h) => <li key={h}>{h}</li>)}</ol>
          <div>
            <p className="mb-1 text-sm font-medium">{t.photos}</p>
            <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <button key={i} type="button" onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))} aria-label="×">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p} alt="" className="size-20 rounded-lg object-cover" />
                </button>
              ))}
              {photos.length < 10 && <button type="button" onClick={() => input.current?.click()} className="grid size-20 place-items-center rounded-lg border border-dashed border-[var(--rule)] text-sm text-[var(--ink-3)]">{t.add}</button>}
            </div>
          </div>
          <input className={field} placeholder={t.name} value={f.name} onChange={set("name")} required autoComplete="given-name" />
          <input className={field} placeholder={t.contact} value={f.contact} onChange={set("contact")} required autoComplete="tel" />
          <div className="grid grid-cols-2 gap-2">
            <input className={field} placeholder={t.city} value={f.city} onChange={set("city")} autoComplete="address-level2" />
            <input className={field} placeholder={t.count} value={f.count} onChange={set("count")} inputMode="numeric" />
          </div>
          <input className={field} placeholder={t.asking} value={f.asking} onChange={set("asking")} inputMode="decimal" />
          <textarea className={field} rows={3} placeholder={t.message} value={f.message} onChange={set("message")} />
          {/* Honeypot: hidden from people, filled in by simple bots. */}
          <input tabIndex={-1} autoComplete="off" className="hidden" value={f.website} onChange={set("website")} aria-hidden />
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />{t.consent}</label>
          {error && <p className="text-sm text-[var(--steal)]">{error}</p>}
          <button disabled={!photos.length || !consent || state === "sending"} className="w-full rounded-lg bg-[var(--accent)] py-3 font-semibold text-white disabled:opacity-40">{state === "sending" ? t.sending : t.send}</button>
          <p className="text-xs text-[var(--ink-3)]">{t.privacy}</p>
        </form>
      )}
    </div>
  );
}
