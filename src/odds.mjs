import fs from 'node:fs';
import path from 'node:path';
import { DATA, log, appendJsonl } from './util.mjs';
import { getFx } from './price.mjs';

// Research log, not alerts: award odds (Polymarket, public and free to read) next to live eBay asking prices
// for the leading players' cards, snapshotted every few hours. After a season this is our own dataset to test
// whether odds moves lead card prices (no published study measures it). Nothing here trades or bets.
const stateFile = path.join(DATA, 'odds-state.json');
const lastRun = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).at || 0; } catch { return 0; } };

async function polymarket(slug) {
  const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`polymarket ${res.status}`);
  const e = (await res.json())[0];
  if (!e) return [];
  return (e.markets || [])
    .filter(m => m.groupItemTitle && !/^(Player|Candidate) [A-Z]+$|^Other$/.test(m.groupItemTitle))
    .map(m => {
      const bid = Number(m.bestBid), ask = Number(m.bestAsk), last = Number(JSON.parse(m.outcomePrices || '[0]')[0]);
      const mid = bid > 0 && ask > 0 && ask < 1 ? (bid + ask) / 2 : last;
      return { player: m.groupItemTitle, prob: +mid.toFixed(4), bid: bid || null, ask: ask || null, volume: Math.round(Number(m.volume || 0)) };
    })
    .sort((a, b) => b.prob - a.prob);
}

// Live Buy It Now asks for a player's cards on eBay (active listings, the only data the free API gives).
async function cardAsks(cfg, token, player, query, fx) {
  const params = new URLSearchParams({ q: `${player} ${query}`, category_ids: '261328', limit: '100', filter: 'buyingOptions:{FIXED_PRICE},deliveryCountry:CA' });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': cfg.ebay.marketplace, 'X-EBAY-C-ENDUSERCTX': `contextualLocation=${encodeURIComponent('country=CA,zip=H7T2W7')}` },
  });
  if (!res.ok) throw new Error(`ebay ${res.status}`);
  const j = await res.json();
  const last = player.split(' ').slice(-1)[0].toLowerCase();
  const cad = (v, c) => (c === 'CAD' ? +v : c === 'USD' ? v * fx.USD : null);
  const split = re => (j.itemSummaries || []).filter(it => it.title.toLowerCase().includes(last) && re.test(it.title)).map(it => cad(it.price?.value, it.price?.currency)).filter(Number.isFinite).sort((a, b) => a - b);
  const stat = xs => (xs.length ? { n: xs.length, p25: +xs[Math.floor(xs.length / 4)].toFixed(2), median: +xs[Math.floor(xs.length / 2)].toFixed(2) } : { n: 0 });
  return { total: j.total ?? 0, raw: stat(split(/^(?!.*\b(PSA|BGS|SGC|CGC|TAG)\b).*/i)), psa10: stat(split(/\bPSA\s*10\b/i)) };
}

export async function logOdds(cfg, getToken) {
  const o = cfg.odds || {};
  if (!o.enabled || Date.now() - lastRun() < (o.everyHours ?? 6) * 3600e3) return;
  fs.writeFileSync(stateFile, JSON.stringify({ at: Date.now() }));
  const fx = await getFx();
  const token = await getToken(cfg.ebayKeys).catch(() => null);
  for (const ev of o.events || []) {
    try {
      const field = await polymarket(ev.slug);
      const at = new Date().toISOString();
      for (const [i, p] of field.entries()) {
        const row = { at, event: ev.label, sport: ev.sport, source: 'polymarket', ...p };
        if (token && i < (o.cardPlayers ?? 6)) row.cards = await cardAsks(cfg, token, p.player, ev.cardQuery || 'rookie', fx).catch(e => ({ error: e.message }));
        appendJsonl('odds', row);
      }
      log(`odds ${ev.label}: ${field.slice(0, 3).map(p => `${p.player} ${Math.round(p.prob * 100)}%`).join(', ')}`);
    } catch (e) { log('odds failed', ev.label, e.message); }
  }
}
