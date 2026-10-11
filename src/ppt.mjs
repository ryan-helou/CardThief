import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, log } from './util.mjs';

// PokemonPriceTracker: real eBay sold prices (ungraded and by grade). Free plan = 100 credits/day,
// credits are per card returned (+1 each for eBay data). On the API plan (20k/day) we ask for the top 3
// matches (~6 credits) so the strict identity check below can pick the exact card.
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
  const key = `${card.name}|${card.number || ''}|${card.language || 'en'}`;
  if (!cache.has(key)) {
    try {
      const q = new URLSearchParams({ search: `${card.name} ${card.number ? String(card.number).split('/')[0] : ''}`.trim(), limit: '3', includeEbay: 'true', ...(card.language === 'jp' ? { language: 'japanese' } : {}) });
      const res = await fetch(`${BASE}/cards?${q}`, { headers: { authorization: `Bearer ${cfg.pptApiKey}` } });
      const left = Number(res.headers.get('x-ratelimit-daily-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-daily-reset'));
      const limit = Number(res.headers.get('x-ratelimit-daily-limit'));
      if (Number.isFinite(left)) fs.writeFileSync(usageFile, JSON.stringify({ remaining: left, limit: Number.isFinite(limit) ? limit : 100, resetAt: (reset || 0) * 1000 }));
      if (!res.ok) throw new Error(`${res.status}`);
      cache.set(key, (await res.json()).data || []);
    } catch (e) {
      log('ppt lookup failed', card.name, e.message);
      return null;
    }
  }
  const list = cache.get(key);
  const num = card.number ? String(card.number).split('/')[0].replace(/^0+/, '') : null;
  // Identity check: same number, same set size when we know it, and the card's main name word.
  const total = card.setTotal || (String(card.number || '').split('/')[1] ? Number(String(card.number).split('/')[1]) : null);
  const word = String(card.name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find(w => w.length >= 3);
  const hit = list.find(c => {
    const [n, t] = String(c.cardNumber || '').split('/');
    if (num && n.replace(/^0+/, '') !== num) return false;
    if (total && t && Number(t) !== Number(total)) return false;
    if (word && !String(c.name || '').toLowerCase().includes(word)) return false;
    return true;
  });
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
