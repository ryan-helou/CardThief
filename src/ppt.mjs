import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, log } from './util.mjs';

// PokemonPriceTracker: real eBay sold prices (ungraded and by grade). Free plan = 100 credits/day,
// credits are per card returned (+1 each for eBay data). On the API plan (20k/day) we ask for the top 3
// matches (~6 credits) only when the single best match (~2 credits) isn't the exact card.
const BASE = 'https://www.pokemonpricetracker.com/api/v2';
const usageFile = path.join(DATA, 'ppt-usage.json');
const cache = new Map();

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
  if (!cache.has(key)) cache.set(key, await fetchCards(cfg, card, cue ? 3 : 1));
  let list = cache.get(key);
  if (list && !list.some(c => matches(c, card))) { list = (await fetchCards(cfg, card, 3)) || list; cache.set(key, list); }
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

async function fetchCards(cfg, card, limit) {
  try {
    const q = new URLSearchParams({ search: `${card.name} ${card.number ? String(card.number).split('/')[0] : ''}`.trim(), limit: String(limit), includeEbay: 'true', ...(card.language === 'jp' ? { language: 'japanese' } : {}) });
    const res = await fetch(`${BASE}/cards?${q}`, { headers: { authorization: `Bearer ${cfg.pptApiKey}` } });
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
function matches(c, card) {
  const num = card.number ? String(card.number).split('/')[0].replace(/^0+/, '') : null;
  const total = card.setTotal || (String(card.number || '').split('/')[1] ? Number(String(card.number).split('/')[1]) : null);
  const word = String(card.name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find(w => w.length >= 3);
  const [n, t] = String(c.cardNumber || '').split('/');
  if (num && n.replace(/^0+/, '') !== num) return false;
  if (total && t && Number(t) !== Number(total)) return false;
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
    const usd = recent ? (s.marketTrend === 'down' ? Math.min(recent, s.medianPrice) : recent) : s.marketTrend === 'down' ? s.medianPrice * 0.8 : s.medianPrice;
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
