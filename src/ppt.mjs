import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, log } from './util.mjs';

// PokemonPriceTracker: real eBay sold prices (ungraded and by grade). Free plan = 100 credits/day,
// credits are per card returned (+1 each for eBay data), so ask for exactly one card: 2 credits a lookup.
const BASE = 'https://www.pokemonpricetracker.com/api/v2';
const usageFile = path.join(DATA, 'ppt-usage.json');
const cache = new Map();

function remaining() {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    return Date.now() < u.resetAt ? u.remaining : 100;
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
  const key = `${card.name}|${card.number || ''}`;
  if (!cache.has(key)) {
    try {
      const q = new URLSearchParams({ search: `${card.name} ${card.number ? String(card.number).split('/')[0] : ''}`.trim(), limit: '1', includeEbay: 'true' });
      const res = await fetch(`${BASE}/cards?${q}`, { headers: { authorization: `Bearer ${cfg.pptApiKey}` } });
      const left = Number(res.headers.get('x-ratelimit-daily-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-daily-reset'));
      if (Number.isFinite(left)) fs.writeFileSync(usageFile, JSON.stringify({ remaining: left, resetAt: (reset || 0) * 1000 }));
      if (!res.ok) throw new Error(`${res.status}`);
      cache.set(key, (await res.json()).data || []);
    } catch (e) {
      log('ppt lookup failed', card.name, e.message);
      return null;
    }
  }
  const list = cache.get(key);
  const num = card.number ? String(card.number).split('/')[0].replace(/^0+/, '') : null;
  const hit = list.find(c => !num || String(c.cardNumber || '').split('/')[0].replace(/^0+/, '') === num) || (num ? null : list[0]);
  if (!hit) return null;
  const sales = hit.ebay?.salesByGrade || {};
  const g = card.grade ? gradeKey(card.grade) : 'ungraded';
  const s = g ? sales[g] : null;
  if (s?.medianPrice && s.count >= 3) {
    return { usd: s.medianPrice, basis: `eBay sold median ${g === 'ungraded' ? 'raw' : g.toUpperCase().replace('_', '.')} (${s.count} sales)`, sales: s.count, lastSale: s.lastSaleDate, id: hit.id, label: hit.name };
  }
  if (!card.grade && hit.prices?.market) return { usd: hit.prices.market, basis: 'TCGplayer market', sales: null, lastSale: null, id: hit.id, label: hit.name };
  return null;
}
