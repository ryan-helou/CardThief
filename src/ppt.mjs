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
const slim = list => list && list.map(c => ({ id: c.id, name: c.name, setName: c.setName, cardNumber: c.cardNumber, prices: { market: c.prices?.market }, ebay: { salesByGrade: c.ebay?.salesByGrade } }));
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

// Pacing: spread what's left evenly until the daily reset, so the credits never run out mid-day
// (checking every eBay slab costs ~1,500/hour at peak; the plan gives 20,000/day).
const spent = []; // [time, credits]
function resetAt() { try { return JSON.parse(fs.readFileSync(usageFile, 'utf8')).resetAt; } catch { return 0; } }
export function pptPaced() {
  const hourAgo = Date.now() - 3600e3;
  while (spent.length && spent[0][0] < hourAgo) spent.shift();
  const used = spent.reduce((a, [, n]) => a + n, 0);
  const hoursLeft = Math.max(1, (resetAt() - Date.now()) / 3600e3);
  return used < (remaining() - (loadConfig().pptReserveCredits ?? 10)) / hoursLeft;
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
  // A miss is remembered too (24h): retrying all three searches for every copy of an unknown card cost
  // ~14 credits a listing and was most of the daily budget.
  if (!cache.has(key)) {
    // No set size in the title ("#12 MOLTRES"): look at a few printings so the set it names can be picked.
    let list = await fetchCards(cfg, card, cue || !total(card) ? 3 : 1);
    if (list && !list.some(c => matches(c, card))) list = (await fetchCards(cfg, card, 3)) || list;
    // Some cards are listed on PPT without the set size: one last try searching by the bare number.
    if (list && !list.some(c => matches(c, card)) && total(card)) list = (await fetchCards(cfg, card, 3, false)) || list;
    // Vintage label titles ("1999 POKEMON JUNGLE 1ST EDITION #6 MR. MIME"): search by name + set instead.
    const set = setHint(card.title || '');
    if (list && !list.some(c => matches(c, card)) && set) list = (await fetchCards(cfg, { ...card, number: null, searchExtra: set }, 5)) || list;
    put(key, list);
  }
  const list = cache.get(key);
  return fromHit(pickPrinting((list || []).filter(c => matches(c, card)), card.title || ''), card);
}

const VARIANT_CUE = /pok[eé]mon cent(er|re)|\bp\.?c\.? etb|stamp|staff|prerelease|pre-release/i;
// "Magneton - 159 (Pokémon Center Exclusive)" → its variant words must appear in the title;
// with no variant named in the title, prefer the plain printing.
function pickPrinting(hits, title) {
  const t = title.toLowerCase().replace(/\bp\.?c\.?(?= etb)/, 'center');
  // The set the title names wins ties: "1999 POKEMON FOSSIL #12 MOLTRES" is the Fossil Moltres, not another #12.
  const setBonus = c => String(c.setName || '').toLowerCase().replace(/pok[eé]mon|promo|black star|cards?/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 4).some(w => t.includes(w)) ? 0.5 : 0;
  const score = c => {
    const v = String(c.name || '').match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
    if (!v) return 1 + setBonus(c);
    const words = v.replace(/pok[eé]mon/g, '').split(/[^a-z]+/).filter(w => w.length >= 4 && w !== 'exclusive');
    return (words.some(w => t.includes(w)) ? 2 : 0) + setBonus(c);
  };
  return hits.sort((a, b) => score(b) - score(a))[0];
}

async function fetchCards(cfg, card, limit, withTotal = true, history = false) {
  try {
    // "pikachu 60/64" finds the Jungle card; "pikachu 60" finds a World Collection promo named "Pikachu (Jungle)".
    const num = card.number ? (withTotal && total(card) ? `${String(card.number).split('/')[0]}/${total(card)}` : String(card.number).split('/')[0]) : '';
    const q = new URLSearchParams({ search: `${card.name} ${num} ${card.searchExtra || ''}`.replace(/\s+/g, ' ').trim(), limit: String(limit), includeEbay: 'true', ...(history ? { includeHistory: 'true' } : {}), ...(card.language === 'jp' ? { language: 'japanese' } : {}) });
    const res = await fetch(`${BASE}/cards?${q}`, { signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${cfg.pptApiKey}` } });
    const left = Number(res.headers.get('x-ratelimit-daily-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-daily-reset'));
    const max = Number(res.headers.get('x-ratelimit-daily-limit'));
    if (Number.isFinite(left)) { const before = remaining(); if (before > left) spent.push([Date.now(), before - left]); }
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
  // "#050" in a title is PPT's "SWSH050": compare the digits when the title gives no letters.
  const digits = x => x.replace(/^[A-Za-z]+-?/, '').replace(/^0+/, '');
  if (num && n.replace(/^0+/, '') !== num && !(/^\d+$/.test(num) && digits(n) === num)) return false;
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
      usd, median: s.medianPrice, recent: Boolean(recent), trend: s.marketTrend || null, weekly: s.dailyVolume7Day != null ? s.dailyVolume7Day * 7 : null,
      basis: `eBay ${label}: ${recent ? `last 7 days US$${Math.round(recent)}` : `no recent sales, all-time median US$${Math.round(s.medianPrice)}`}${trend} (${s.count} sales total)`,
      sales: s.count, lastSale: s.lastSaleDate, id: hit.id, label: hit.name,
    };
  }
  if (!card.grade && hit.prices?.market) return { usd: hit.prices.market, basis: 'TCGplayer market', sales: null, lastSale: null, id: hit.id, label: hit.name };
  return null;
}

// Day-by-day sales for one grade over the last 30 days, fetched only for alert candidates (+1 credit).
// The basis for the strict value: the median of actual sales, not a weekly average a spike can drag up.
const salesCache = new Map();
export async function pptSales(card) {
  const cfg = loadConfig();
  if (!pptAvailable() || !card?.name) return null;
  const key = `${card.name}|${card.number || ''}|${card.language || 'en'}|${VARIANT_CUE.test(card.title || '') ? 'v' : ''}`;
  let hit = salesCache.get(key);
  if (!hit || Date.now() - hit.at > 6 * 3600e3) {
    let list = await fetchCards(cfg, card, VARIANT_CUE.test(card.title || '') ? 3 : 1, true, true);
    if (list && !list.some(c => matches(c, card))) list = (await fetchCards(cfg, card, 3, true, true)) || list;
    if (list && !list.some(c => matches(c, card)) && total(card)) list = (await fetchCards(cfg, card, 3, false, true)) || list;
    if (!list) return null;
    hit = { at: Date.now(), c: pickPrinting(list.filter(c => matches(c, card)), card.title || '') };
    salesCache.set(key, hit);
  }
  const days = Object.entries(hit.c?.ebay?.priceHistory?.[card.grade ? gradeKey(card.grade) : 'ungraded'] || {})
    .filter(([d]) => Date.parse(d) >= Date.now() - 30 * 864e5).sort(([a], [b]) => a.localeCompare(b));
  const sales = days.flatMap(([, v]) => Array(Math.max(1, v.count || 1)).fill(v.average)).filter(x => x > 0);
  const sorted = [...sales].sort((a, b) => a - b);
  // Drop junk like a US$0.99 cancelled sale: anything under a fifth of the median.
  const mid = sorted[Math.floor(sorted.length / 2)] || 0;
  const clean = sorted.filter(x => x >= mid * 0.2);
  return {
    label: hit.c?.name || null,
    sales: clean,
    median: clean.length ? clean[Math.floor((clean.length - 1) / 2)] : null, // lower median
    days: days.map(([d, v]) => `${d}: US$${Math.round(v.average)}${(v.count || 1) > 1 ? ` x${v.count}` : ''}`),
  };
}

const SETS = ['base set 2', 'base set', 'jungle', 'fossil', 'team rocket', 'gym heroes', 'gym challenge', 'neo genesis', 'neo discovery',
  'neo revelation', 'neo destiny', 'legendary collection', 'expedition', 'aquapolis', 'skyridge', 'southern islands'];
function setHint(title) {
  const t = title.toLowerCase();
  const hit = SETS.find(x => t.includes(x)) || (/\brocket\b/.test(t) ? 'team rocket' : null);
  return hit;
}
