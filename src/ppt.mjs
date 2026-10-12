import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, log } from './util.mjs';

// PokemonPriceTracker: real eBay sold prices (ungraded and by grade). Free plan = 100 credits/day,
// credits are per card returned (+1 each for eBay data). On the API plan (20k/day) we ask for the top 3
// matches (~6 credits) only when the single best match (~2 credits) isn't the exact card.
const BASE = 'https://www.pokemonpricetracker.com/api/v2';
const usageFile = path.join(DATA, 'ppt-usage.json');
// Lookups are cached on disk for 24 hours (one lookup covers every grade of a card), so restarts
// don't re-spend credits. Only the fields we read are kept, which keeps the file small.
const cacheFile = path.join(DATA, 'ppt-cache.json');
const TTL = 24 * 3600e3;
const disk = (() => { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; } })();
let dirty = 0;
const slim = list => list && list.map(c => ({ id: c.id, name: c.name, cardNumber: c.cardNumber, prices: { market: c.prices?.market }, ebay: { salesByGrade: c.ebay?.salesByGrade } }));
const cache = {
  has: k => Boolean(disk[k] && Date.now() - disk[k].at < TTL),
  get: k => disk[k]?.list,
};
function put(k, list) {
  if (!list) return; // a failed lookup (network) is retried next time, not remembered
  disk[k] = { at: Date.now(), list: slim(list) };
  if (++dirty % 10 === 0) {
    for (const [key, v] of Object.entries(disk)) if (Date.now() - v.at > TTL) delete disk[key];
    fs.writeFileSync(cacheFile, JSON.stringify(disk));
  }
}
process.on('exit', () => { try { fs.writeFileSync(cacheFile, JSON.stringify(disk)); } catch {} });
process.once('SIGTERM', () => process.exit(0)); // launchd restarts send SIGTERM; save the cache first

function remaining() {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    return Date.now() < u.resetAt ? u.remaining : (u.limit || 100);
  } catch { return 100; }
}

export function pptAvailable() {
  const cfg = loadConfig();
  return Boolean(cfg.pptApiKey) && remaining() > (cfg.pptReserveCredits ?? 10);
}

const gradeKey = g => {
  const m = String(g || '').match(/(psa|cgc|bgs|sgc|tag|ace)\s*-?\s*(\d+(?:\.\d)?)/i);
  return m ? `${m[1].toLowerCase()}${m[2].replace('.', '_')}` : null;
};

// { name, number, grade? } → { usd, basis, sales, lastSale } | null
export async function pptPrice(card) {
  const cfg = loadConfig();
  if (!pptAvailable() || !card?.name) return null;
  // Stamped printings (Pokémon Center, Staff, Prerelease…) are separate cards on PPT and sell for far
  // more: a Pokémon Center Magneton 159 PSA 10 is ~US$190 vs ~US$107 for the regular one. When the
  // title hints at one, look at several matches and take the printing the title names.
  const cue = VARIANT_CUE.test(card.title || '');
  const key = `${card.name}|${card.number || ''}|${card.language || 'en'}|${cue ? 'v' : ''}`;
  if (!cache.has(key)) put(key, await fetchCards(cfg, card, cue ? 3 : 1));
  let list = cache.get(key);
  if (list && !list.some(c => matches(c, card))) { list = (await fetchCards(cfg, card, 3)) || list; put(key, list); list = cache.get(key); }
  // Some cards are listed on PPT without the set size: one last try searching by the bare number.
  if (list && !list.some(c => matches(c, card)) && total(card)) { list = (await fetchCards(cfg, card, 3, false)) || list; put(key, list); list = cache.get(key); }
  return fromHit(pickPrinting((list || []).filter(c => matches(c, card)), card.title || ''), card);
}

const VARIANT_CUE = /pok[eé]mon cent(er|re)|\bp\.?c\.? etb|stamp|staff|prerelease|pre-release/i;
// "Magneton - 159 (Pokémon Center Exclusive)" → its variant words must appear in the title;
// with no variant named in the title, prefer the plain printing.
function pickPrinting(hits, title) {
  const t = title.toLowerCase().replace(/\bp\.?c\.?(?= etb)/, 'center');
  const score = c => {
    const v = String(c.name || '').match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
    if (!v) return 1;
    const words = v.replace(/pok[eé]mon/g, '').split(/[^a-z]+/).filter(w => w.length >= 4 && w !== 'exclusive');
    return words.some(w => t.includes(w)) ? 2 : 0;
  };
  return hits.sort((a, b) => score(b) - score(a))[0];
}

async function fetchCards(cfg, card, limit, withTotal = true) {
  try {
    // "pikachu 60/64" finds the Jungle card; "pikachu 60" finds a World Collection promo named "Pikachu (Jungle)".
    const num = card.number ? (withTotal && total(card) ? `${String(card.number).split('/')[0]}/${total(card)}` : String(card.number).split('/')[0]) : '';
    const q = new URLSearchParams({ search: `${card.name} ${num}`.trim(), limit: String(limit), includeEbay: 'true', ...(card.language === 'jp' ? { language: 'japanese' } : {}) });
    const res = await fetch(`${BASE}/cards?${q}`, { signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${cfg.pptApiKey}` } });
    const left = Number(res.headers.get('x-ratelimit-daily-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-daily-reset'));
    const max = Number(res.headers.get('x-ratelimit-daily-limit'));
    if (Number.isFinite(left)) fs.writeFileSync(usageFile, JSON.stringify({ remaining: left, limit: Number.isFinite(max) ? max : 100, resetAt: (reset || 0) * 1000 }));
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()).data || [];
  } catch (e) {
    log('ppt lookup failed', card.name, e.message);
    return null;
  }
}

// Identity check: same number, same set size when we know it, and the card's main name word.
const total = card => card.setTotal || (String(card.number || '').split('/')[1] ? Number(String(card.number).split('/')[1]) : null);

function matches(c, card) {
  const num = card.number ? String(card.number).split('/')[0].replace(/^0+/, '') : null;
  const tot = total(card);
  const word = String(card.name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find(w => w.length >= 3);
  const [n, t] = String(c.cardNumber || '').split('/');
  if (num && n.replace(/^0+/, '') !== num) return false;
  if (tot && t && Number(t) !== Number(tot)) return false;
  // The listing names a set size (60/64) but this entry has none: it's a promo or reprint, not the set card.
  if (tot && !t && !/promo/i.test(card.title || '')) return false;
  if (word && !String(c.name || '').toLowerCase().includes(word)) return false;
  return true;
}

function fromHit(hit, card) {
  if (!hit) return null;
  const sales = hit.ebay?.salesByGrade || {};
  const g = card.grade ? gradeKey(card.grade) : 'ungraded';
  const s = g ? sales[g] : null;
  if (s?.medianPrice && s.count >= 1) {
    // Value on RECENT sales: the all-time median lags a falling market (a PSA 10 at a $172 median
    // was really selling for ~$100 that week). Prefer PPT's 7-day price; if it's missing, only trust
    // the long median when the trend isn't down, and take the lower of the two otherwise.
    const recent = s.smartMarketPrice?.confidence !== 'low' && s.smartMarketPrice?.price ? s.smartMarketPrice.price : s.marketPriceMedian7Day || s.marketPrice7Day || null;
    // A week with one or two odd sales (a mislabelled 1st Edition, a bundle) can double the 7-day price:
    // never value above 1.3x the longer-run price. Jungle Pikachu PSA 7: 7-day US$96, median US$30.
    const steady = Math.max(s.medianPrice, s.smartMarketPrice?.price || 0) * 1.3;
    const usd = recent ? Math.min(s.marketTrend === 'down' ? Math.min(recent, s.medianPrice) : recent, steady) : s.marketTrend === 'down' ? s.medianPrice * 0.8 : s.medianPrice;
    const label = g === 'ungraded' ? 'raw' : g.toUpperCase().replace('_', '.');
    const trend = s.marketTrend === 'down' ? ' ↓ falling' : s.marketTrend === 'up' ? ' ↑ rising' : '';
    return {
      usd, recent: Boolean(recent), trend: s.marketTrend || null, weekly: s.dailyVolume7Day != null ? s.dailyVolume7Day * 7 : null,
      basis: `eBay ${label}: ${recent ? `last 7 days US$${Math.round(recent)}` : `no recent sales, all-time median US$${Math.round(s.medianPrice)}`}${trend} (${s.count} sales total)`,
      sales: s.count, lastSale: s.lastSaleDate, id: hit.id, label: hit.name,
    };
  }
  if (!card.grade && hit.prices?.market) return { usd: hit.prices.market, basis: 'TCGplayer market', sales: null, lastSale: null, id: hit.id, label: hit.name };
  return null;
}
