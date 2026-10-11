import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, log, sleep, jitter, Seen, appendJsonl, DATA } from './util.mjs';
import { searchKijiji, kijijiDetail } from './sources/kijiji.mjs';
import { searchEbay, ebayDetail, ebayReady } from './sources/ebay.mjs';
import { sweepFacebook, facebookDetail, inActiveHours } from './sources/facebook.mjs';
import { prefilter, judge, aiUsage } from './judge.mjs';
import { judgeSlab } from './slabs.mjs';
import { toDeal, sendDeal, heartbeat, retryPendingDeals } from './notify.mjs';
import { getFx } from './price.mjs';
import { distanceKm } from './geo.mjs';
import { processOutbox } from './outbox.mjs';
import { buildReport } from './report.mjs';

const ONCE = process.argv.includes('--once');
const seen = new Seen('seen');
const statePath = path.join(DATA, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));

const queue = [];
const startedAt = new Date().toISOString();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const stats = { day: today(), judged: 0, deals: 0, kijiji: null, ebay: null, facebook: null, lastError: null };
const judgedAt = []; // any AI check (Haiku or Sonnet)
const sonnetAt = []; // full Sonnet checks only
let judgePausedUntil = 0;

async function enqueue(cfg, l) {
  if (seen.has(l.id) || queue.some(q => q.id === l.id)) return;
  // Local pickup only: drop listings too far to drive to (eBay ships, so it's exempt).
  if (l.source !== 'ebay' && cfg.maxDistanceKm) {
    const d = await distanceKm(l.location);
    if (d != null) l.distanceKm = d;
    if (d != null && d > cfg.maxDistanceKm) { seen.add(l.id); appendJsonl('skipped', { at: new Date().toISOString(), id: l.id, title: l.title, price: l.priceCad, why: `${d} km away` }); return; }
  }
  const age = Date.now() - new Date(l.postedAt).getTime();
  // Old or bumped ad. Auctions are exempt: they're listed days before the ending we care about.
  const auction = l.buyingOptions?.includes('AUCTION') && !l.buyingOptions?.includes('FIXED_PRICE');
  if (!auction && age > cfg.firstRunLookbackHours * 3600e3) { seen.add(l.id); return; }
  const why = prefilter(cfg, l);
  if (why) { seen.add(l.id); appendJsonl('skipped', { at: new Date().toISOString(), id: l.id, title: l.title, price: l.priceCad, why }); return; }
  queue.push(l);
}

async function pollKijiji(cfg) {
  for (const url of cfg.kijiji.searches) {
    try {
      const list = await searchKijiji(url);
      for (const l of list) await enqueue(cfg, l);
      stats.kijiji = new Date().toISOString();
    } catch (e) { log('kijiji search failed', e.message); stats.lastError = `kijiji: ${e.message}`; }
    await sleep(jitter(4000));
  }
}

async function pollEbay(cfg) {
  if (!ebayReady(cfg)) return;
  const fx = await getFx();
  for (const q of cfg.ebay.queries) {
    const key = `ebay:${q.q}:${q.filter}`;
    const since = new Date(state[key] || Date.now() - cfg.firstRunLookbackHours * 3600e3);
    const started = new Date();
    try {
      const list = await searchEbay(cfg, q, since, fx);
      for (const l of list) await enqueue(cfg, l);
      stats.ebay = new Date().toISOString();
      state[key] = new Date(started.getTime() - 5 * 60e3).toISOString(); // small overlap; seen-set dedupes
    } catch (e) { log('ebay search failed', q.q, e.message); }
  }
  saveState();
}

async function pollFacebook(cfg) {
  try {
    const list = await sweepFacebook(cfg);
    for (const l of list) await enqueue(cfg, l);
    stats.facebook = new Date().toISOString();
    log(`facebook sweep: ${list.length} listings, queue ${queue.length}`);
  } catch (e) { log('facebook sweep failed', e.message); stats.lastError = `facebook: ${e.message}`.slice(0, 200); }
}

// Check in with the app; the app calls the bot "quiet" after 15 minutes without one.
const beat = c => heartbeat(buildReport(c, {
  kijiji: stats.kijiji, facebook: c.facebook?.enabled ? stats.facebook : null, ebay: ebayReady(c) ? stats.ebay : null,
  queue: queue.length, queueBySource: queue.reduce((a, x) => ({ ...a, [x.source]: (a[x.source] || 0) + 1 }), {}),
  judgedToday: stats.judged, dealsToday: stats.deals, lastError: stats.lastError, startedAt,
}));

// Deals go stale in hours, so when more arrives than Mint can check, keep the newest
// and drop the rest (unseen, so a relisting can come back). Marketplace/Kijiji are kept first: they're the best source.
function trimQueue(cfg) {
  const max = cfg.maxQueue ?? 300;
  if (queue.length <= max) return;
  const local = queue.filter(x => x.source !== 'ebay');
  const ebay = queue.filter(x => x.source === 'ebay').sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
  const keep = [...local, ...ebay].slice(0, max);
  log(`queue trimmed: ${queue.length} → ${keep.length} (kept the newest)`);
  queue.splice(0, queue.length, ...keep);
}

async function drain(cfg) {
  trimQueue(cfg);
  if (Date.now() < judgePausedUntil) return;
  // Judge for a few minutes at most, then let the searches run again; otherwise a long queue starves them.
  const until = Date.now() + (cfg.drainMinutes ?? 3) * 60e3;
  while (queue.length && Date.now() < until) {
    await processOutbox();
    await beat(cfg);
    const hourAgo = Date.now() - 3600e3;
    while (judgedAt.length && judgedAt[0] < hourAgo) judgedAt.shift();
    while (sonnetAt.length && sonnetAt[0] < hourAgo) sonnetAt.shift();
    if (judgedAt.length >= (cfg.maxTriagePerHour || cfg.maxJudgementsPerHour)) { log(`judge budget hit, ${queue.length} waiting`); return; }
    // Cheapest first: the best ROI tends to hide in the low-priced listings.
    // Cheapest first, but $0–2 "placeholder" prices last: their real price is unknown.
    const rank = x => (x.priceCad <= 2 ? 1e6 + x.priceCad : x.priceCad);
    queue.sort((a, b) => rank(a) - rank(b));
    let l = queue.shift();
    judgedAt.push(Date.now());
    try {
      // Kijiji pages are a cheap HTTP fetch; Marketplace pages need a browser, so they're opened only for Stage 3.
      if (l.source === 'kijiji') l = await kijijiDetail(l);
      if (l.source === 'ebay' && cfg.mode !== 'slabs') l = await ebayDetail(cfg, l, await getFx());
      const r = cfg.mode === 'slabs' && l.source === 'ebay'
        ? await judgeSlab(cfg, l)
        : await judge(cfg, l, { allowStage3: sonnetAt.length < cfg.maxJudgementsPerHour, detail: l.source === 'facebook' ? x => facebookDetail(cfg, x) : null });
      if (r.stage === 3) sonnetAt.push(Date.now());
      if (r.stage === 1) judgedAt.pop(); // priced from the title: no AI used, doesn't count toward the hourly cap
      seen.add(l.id); seen.save();
      stats.judged++;
      const rec = { at: new Date().toISOString(), photo: l.images?.[0] || null, stage: r.stage, aiCalls: aiUsage.calls, aiUsd: +aiUsage.usd.toFixed(4), id: l.id, url: l.url, title: l.title, price: l.priceCad, tier: r.tier, profit: +r.profit.toFixed(2), roi: +r.roi.toFixed(2), resale: +r.resale.toFixed(2), kind: r.ident.kind, fakeRisk: r.ident.fakeRisk, lines: r.lines, summary: r.ident.summary, askSeller: r.ident.askSeller };
      appendJsonl('judged', rec);
      log(`${r.tier.toUpperCase().padEnd(5)} s${r.stage} ${l.id} $${l.priceCad} → profit $${r.profit.toFixed(0)} (${Math.round(r.roi * 100)}%) ${l.title}`);
      if (r.tier !== 'pass') {
        appendJsonl('deals', rec);
        stats.deals++;
        await sendDeal(toDeal(l, r));
      }
    } catch (e) {
      log('judge failed', l.id, e.message);
      stats.lastError = `${new Date().toISOString()} ${e.message}`.slice(0, 200);
      // Logged out / usage limit: nothing is wrong with the listing, so keep it queued and retry later.
      if (/authenticat|log ?in|usage limit|rate limit|overloaded/i.test(e.message)) {
        queue.unshift(l);
        judgedAt.pop();
        judgePausedUntil = Date.now() + 2 * 60e3;
        return;
      }
      l.failures = (l.failures || 0) + 1;
      if (l.failures < 3) queue.push(l); else { seen.add(l.id); seen.save(); }
      await sleep(30_000);
    }
  }
}

async function main() {
  const cfg = loadConfig();
  log(`CardThief up · kijiji ${cfg.kijiji.enabled ? 'on' : 'off'} · facebook ${cfg.facebook?.enabled ? 'on' : 'off'} · ebay ${ebayReady(cfg) ? 'on' : 'off (no keys yet)'} · seen ${seen.size}`);
  let nextKijiji = 0, nextEbay = 0, nextFacebook = 0;
  for (;;) {
    const c = loadConfig(); // re-read so config edits apply without a restart
    const now = Date.now();
    if (c.kijiji.enabled && now >= nextKijiji) { await pollKijiji(c); nextKijiji = now + jitter(c.kijiji.everyMinutes * 60e3); }
    if (c.ebay.enabled && now >= nextEbay) { await pollEbay(c); nextEbay = now + jitter(c.ebay.everyMinutes * 60e3); }
    if (c.facebook?.enabled && now >= nextFacebook && inActiveHours(c)) { await pollFacebook(c); nextFacebook = now + jitter(c.facebook.everyMinutes * 60e3, 0.3); }
    seen.save();
    if (stats.day !== today()) Object.assign(stats, { day: today(), judged: 0, deals: 0 });
    await beat(c);
    await retryPendingDeals();
    await processOutbox();
    await drain(c);
    await beat(c);
    if (ONCE) break;
    await sleep(20_000);
  }
  log('done');
}

// A stray stream error must never take the hunter down; log it and keep going.
process.on('uncaughtException', e => log('uncaught', e.code || '', e.message));
process.on('unhandledRejection', e => log('unhandled rejection', e?.message || String(e)));

main().catch(e => { log('fatal', e.stack || e.message); process.exit(1); });
