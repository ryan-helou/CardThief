import { execFile } from 'node:child_process';
import { loadConfig, log } from './util.mjs';

// Deals go to the CardThief app (Railway), which stores them and pushes to Ryan's phone.
// The Mac also shows a banner so a deal is visible even when the phone is away.

async function app(path, body) {
  const cfg = loadConfig();
  if (!cfg.appUrl || !cfg.agentToken) return null;
  const res = await fetch(new URL(path, cfg.appUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.agentToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`app ${path} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Short opener, per Ryan's BikeHunt rule: "still available?" plus one thing. French unless the ad is in English.
export function draftMessage(l, r) {
  const text = `${l.title} ${l.description || ''}`;
  const fr = (text.match(/\b(cartes?|le|la|les|des|et|avec|pour|tr[eè]s|vendre|à)\b/gi) || []).length >= (text.match(/\b(cards?|the|and|with|for|very|sell|selling)\b/gi) || []).length;
  const lowball = r.offer < (r.price ?? l.priceCad);
  if (fr) return lowball
    ? `Bonjour! Toujours disponible? Je peux passer aujourd'hui avec ${r.offer}$ comptant, ça vous irait?`
    : `Bonjour! Toujours disponible? Je peux passer aujourd'hui, à quelle heure ça vous irait?`;
  return lowball
    ? `Hi! Is this still available? I can pick it up today for $${r.offer} cash, would that work?`
    : `Hi! Is this still available? I can pick it up today, what time works for you?`;
}

export function toDeal(l, r) {
  return {
    id: l.id,
    source: l.source,
    url: l.url,
    title: l.title,
    photo: l.images?.[0],
    location: l.distanceKm != null ? `${l.location} · ${l.distanceKm} km` : l.location,
    postedAt: l.postedAt,
    foundAt: new Date().toISOString(),
    price: r.price ?? l.priceCad,
    shipping: l.shippingCad || 0,
    cost: +r.cost.toFixed(2),
    resale: +r.resale.toFixed(2),
    profit: +r.profit.toFixed(2),
    roi: +r.roi.toFixed(3),
    tier: r.tier,
    kind: r.ident.kind,
    fakeRisk: r.ident.fakeRisk,
    fakeReasons: r.ident.fakeReasons || '',
    lines: r.lines,
    summary: r.ident.summary,
    hiddenUpside: r.ident.hiddenUpside || '',
    askSeller: r.ident.askSeller || '',
    offer: r.offer,
    draft: l.source === 'ebay' ? '' : draftMessage(l, r),
    bids: l.bids ?? null,
    endsAt: l.endsAt ?? null,
    seller: l.seller || '',
  };
}

export async function sendDeal(deal) {
  try {
    const r = await app('/api/agent/deal', deal);
    if (r) log('app deal', deal.id, r.isNew ? 'new' : 'updated', JSON.stringify(r.push));
  } catch (e) {
    log('app deal failed', e.message);
  }
  macBanner(`${deal.tier === 'steal' ? '🔥 Steal' : 'Good deal'} +$${Math.round(deal.profit)}`, `$${deal.price} · ${deal.title}`);
}

export async function heartbeat(h) {
  try { await app('/api/agent/heartbeat', h); } catch (e) { log('heartbeat failed', e.message); }
}

function macBanner(title, msg) {
  const esc = s => String(s).replace(/["\\]/g, ' ').slice(0, 200);
  execFile('osascript', ['-e', `display notification "${esc(msg)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}
