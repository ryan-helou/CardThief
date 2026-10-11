import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './util.mjs';
import { ebayCallsToday } from './sources/ebay.mjs';
import { inActiveHours } from './sources/facebook.mjs';

// Everything the app shows about how Mint is doing, built from the bot's own logs.
// Rebuilt at most once a minute (the logs only grow by a few lines a minute).

const readJsonl = name => {
  try { return fs.readFileSync(path.join(DATA, `${name}.jsonl`), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; } };

// Midnight in Montréal, as an ISO string, so "today" matches Ryan's day.
function localMidnightIso(daysAgo = 0) {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const offset = now - local;
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - daysAgo);
  return new Date(local.getTime() + offset).toISOString();
}

const source = id => String(id).split(':')[0];
// "PSA 8 below minimum grade" → "Below minimum grade"; "C$100 all-in; 24 others listed…" → "Not cheaper than other listings"
function reasonGroup(why = '') {
  const w = why.toLowerCase();
  if (/others listed|asking only/.test(w)) return 'Not cheaper than other copies for sale';
  if (/no ebay sold data|no price data/.test(w)) return 'No sold data to price it';
  if (/ceiling/.test(w)) return 'Already priced above what it could be worth';
  if (/non-english|korean|chinese|japanese slab \(turned/.test(w)) return 'Language not tracked';
  if (/grader .* not tracked/.test(w)) return 'Grader not tracked';
  if (/identify|couldn't read/.test(w)) return "Couldn't identify the card";
  if (/over max buy/.test(w)) return 'Over max price';
  if (/km away/.test(w)) return 'Too far for pickup';
  if (/excluded item|not pokemon|no card keywords|not a single graded/.test(w)) return 'Not Pokémon cards';
  if (/sold|pending|wanted|trade post|free\/zero|placeholder/.test(w)) return 'Sold, wanted, trade or placeholder post';
  if (/foreign ebay single|ships from asia/.test(w)) return 'Foreign single (cross-border costs)';
  if (/photo check failed|cert check failed/.test(w)) return 'Failed photo or cert check';
  return 'Fairly priced or overpriced';
}

let cached = null, cachedAt = 0;
export function buildReport(cfg, live) {
  if (cached && Date.now() - cachedAt < 60_000) return { ...cached, ...live };
  const since = localMidnightIso(0), weekSince = localMidnightIso(6);
  const judgedAll = readJsonl('judged'), skippedAll = readJsonl('skipped');
  const judged = judgedAll.filter(r => r.at >= since);
  const skipped = skippedAll.filter(r => r.at >= since);

  const bySource = {};
  const bump = (s, k) => { bySource[s] ??= { found: 0, skipped: 0, judged: 0, deals: 0 }; bySource[s][k]++; };
  for (const r of skipped) { bump(source(r.id), 'found'); bump(source(r.id), 'skipped'); }
  for (const r of judged) { bump(source(r.id), 'found'); bump(source(r.id), 'judged'); if (r.tier !== 'pass') bump(source(r.id), 'deals'); }

  const reasons = {};
  for (const r of skipped) reasons[reasonGroup(r.why)] = (reasons[reasonGroup(r.why)] || 0) + 1;
  for (const r of judged.filter(r => r.tier === 'pass')) reasons[reasonGroup(r.summary)] = (reasons[reasonGroup(r.summary)] || 0) + 1;

  const stages = { 1: 0, 2: 0, 3: 0 };
  for (const r of judged) stages[r.stage || 1] = (stages[r.stage || 1] || 0) + 1;

  const slim = r => ({ at: r.at, source: source(r.id), title: r.title, url: r.url, photo: r.photo || null, tier: r.tier, stage: r.stage || 1, price: r.price, profit: r.profit, roi: r.roi, why: (r.summary || '').slice(0, 220) });
  // Closest calls among listings Mint actually valued (resale > 0), even if they'd lose a little.
  const nearMisses = judged.filter(r => r.tier === 'pass' && r.resale > 0 && r.price).sort((a, b) => b.profit - a.profit).slice(0, 12).map(slim);
  const recent = judged.slice(-25).reverse().map(slim);

  const week = [];
  for (let d = 6; d >= 0; d--) {
    const from = localMidnightIso(d), to = d ? localMidnightIso(d - 1) : '9999';
    const j = judgedAll.filter(r => r.at >= from && r.at < to), s = skippedAll.filter(r => r.at >= from && r.at < to);
    week.push({ day: from.slice(0, 10), found: j.length + s.length, judged: j.length, deals: j.filter(r => r.tier !== 'pass').length });
  }

  const ppt = readJson('ppt-usage.json', null);
  const sent = readJson('messages-sent.json', {});
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  cached = {
    today: { found: judged.length + skipped.length, skipped: skipped.length, judged: judged.length, deals: judged.filter(r => r.tier !== 'pass').length, stages, bySource, reasons },
    week: week.filter(d => d.day >= weekSince.slice(0, 10)),
    nearMisses, recent,
    budgets: {
      pptLeft: ppt && Date.now() < ppt.resetAt ? ppt.remaining : 100, pptMax: 100,
      ebayCalls: ebayCallsToday(), ebayMax: 5000,
      messages: sent[todayKey] || 0, messagesMax: cfg.maxMessagesPerDay ?? 8,
    },
    sources: {
      ebay: { on: Boolean(cfg.ebay?.enabled), mode: cfg.mode === 'slabs' ? 'Graded slabs' : 'All cards', every: cfg.ebay?.everyMinutes },
      facebook: { on: Boolean(cfg.facebook?.enabled), every: cfg.facebook?.everyMinutes, hours: cfg.facebook?.activeHours, active: cfg.facebook?.enabled ? inActiveHours(cfg) : false },
      kijiji: { on: Boolean(cfg.kijiji?.enabled), every: cfg.kijiji?.everyMinutes },
    },
    rules: {
      steal: cfg.deal.steal, good: cfg.deal.good, maxBuy: cfg.maxBuyCad, minPrice: cfg.minPriceCad ?? 0,
      maxDistanceKm: cfg.maxDistanceKm, graders: cfg.slabs?.graders, japanese: Boolean(cfg.slabs?.allowJapanese),
      belowCheapest: cfg.slabs?.minBelowCheapest, offerRatio: cfg.slabs?.minOfferRatio, maxBids: cfg.slabs?.maxBids,
      ebayFee: cfg.money.ebaySellFee, tax: cfg.money.buyerTaxOnline, resaleShip: cfg.slabs?.resaleShipCad,
      haikuPerHour: cfg.maxTriagePerHour, sonnetPerHour: cfg.maxJudgementsPerHour, maxQueue: cfg.maxQueue,
    },
  };
  cachedAt = Date.now();
  return { ...cached, ...live };
}
