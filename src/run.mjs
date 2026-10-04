import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, log, sleep, jitter, Seen, appendJsonl, DATA } from './util.mjs';
import { searchKijiji, kijijiDetail } from './sources/kijiji.mjs';
import { searchEbay, ebayDetail, ebayReady } from './sources/ebay.mjs';
import { sweepFacebook, facebookDetail, inActiveHours } from './sources/facebook.mjs';
import { prefilter, judge } from './judge.mjs';
import { toDeal, sendDeal, heartbeat } from './notify.mjs';
import { getFx } from './price.mjs';
import { distanceKm } from './geo.mjs';
import { processOutbox } from './outbox.mjs';

const ONCE = process.argv.includes('--once');
const seen = new Seen('seen');
const statePath = path.join(DATA, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));

const queue = [];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const stats = { day: today(), judged: 0, deals: 0, kijiji: null, ebay: null, facebook: null, lastError: null };
const judgedAt = [];
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
  if (age > cfg.firstRunLookbackHours * 3600e3) { seen.add(l.id); return; } // old or bumped ad
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
const beat = c => heartbeat({ kijiji: stats.kijiji, facebook: c.facebook?.enabled ? stats.facebook : null, ebay: ebayReady(c) ? stats.ebay : null, queue: queue.length, judgedToday: stats.judged, dealsToday: stats.deals, lastError: stats.lastError });

async function drain(cfg) {
  if (Date.now() < judgePausedUntil) return;
  while (queue.length) {
    await processOutbox();
    await beat(cfg);
    const hourAgo = Date.now() - 3600e3;
    while (judgedAt.length && judgedAt[0] < hourAgo) judgedAt.shift();
    if (judgedAt.length >= cfg.maxJudgementsPerHour) { log(`judge budget hit, ${queue.length} waiting`); return; }
    // Cheapest first: the best ROI tends to hide in the low-priced listings.
    queue.sort((a, b) => a.priceCad - b.priceCad);
    let l = queue.shift();
    judgedAt.push(Date.now());
    try {
      if (l.source === 'kijiji') l = await kijijiDetail(l);
      if (l.source === 'ebay') l = await ebayDetail(cfg, l, await getFx());
      if (l.source === 'facebook') l = await facebookDetail(cfg, l);
      const r = await judge(cfg, l);
      seen.add(l.id); seen.save();
      stats.judged++;
      const rec = { at: new Date().toISOString(), id: l.id, url: l.url, title: l.title, price: l.priceCad, tier: r.tier, profit: +r.profit.toFixed(2), roi: +r.roi.toFixed(2), resale: +r.resale.toFixed(2), kind: r.ident.kind, fakeRisk: r.ident.fakeRisk, lines: r.lines, summary: r.ident.summary, askSeller: r.ident.askSeller };
      appendJsonl('judged', rec);
      log(`${r.tier.toUpperCase().padEnd(5)} ${l.id} $${l.priceCad} → profit $${r.profit.toFixed(0)} (${Math.round(r.roi * 100)}%) ${l.title}`);
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
    await processOutbox();
    await drain(c);
    await beat(c);
    if (ONCE) break;
    await sleep(20_000);
  }
  log('done');
}

main().catch(e => { log('fatal', e.stack || e.message); process.exit(1); });
