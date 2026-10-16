import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig, log, sleep, jitter, Seen, appendJsonl, DATA } from './util.mjs';
import { searchKijiji, kijijiDetail } from './sources/kijiji.mjs';
import { searchEbay, ebayDetail, ebayReady } from './sources/ebay.mjs';
import { sweepFacebook, facebookDetail, inActiveHours } from './sources/facebook.mjs';
import { prefilter, judge, aiUsage } from './judge.mjs';
import { judgeSlab } from './slabs.mjs';
import { judgeRaw } from './raw.mjs';
import { pptPaced } from './ppt.mjs';
import { toDeal, sendDeal, heartbeat, retryPendingDeals } from './notify.mjs';
import { getFx } from './price.mjs';
import { distanceKm } from './geo.mjs';
import { processOutbox } from './outbox.mjs';
import { buildReport } from './report.mjs';
import { trackOutcomes } from './outcomes.mjs';
import { processQuotes } from './quotes.mjs';
import { logOdds } from './odds.mjs';
import { getToken } from './sources/ebay.mjs';

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

const lastRun = {};
async function pollEbay(cfg) {
  if (!ebayReady(cfg)) return;
  const fx = await getFx();
  for (const q of cfg.ebay.queries) {
    if (q.enabled === false || (q.raw && !cfg.raw?.enabled)) continue;
    const key = `ebay:${q.q}:${q.filter}`;
    // Some searches run less often than every loop (raw singles: lots of listings, mostly not deals).
    if (q.everyMinutes && Date.now() - (lastRun[key] || 0) < q.everyMinutes * 60e3) continue;
    lastRun[key] = Date.now();
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
  const newest = xs => xs.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
  // Raw singles (shadow test) are kept last: they must never push a slab out of the queue.
  const keep = [...local, ...newest(queue.filter(x => x.source === 'ebay' && !x.raw)), ...newest(queue.filter(x => x.raw)).slice(0, cfg.raw?.maxQueue ?? 150)].slice(0, max);
  log(`queue trimmed: ${queue.length} → ${keep.length} (kept the newest)`);
  queue.splice(0, queue.length, ...keep);
}

// Steals last ~30 minutes (a Magneton TAG 10 at a third of value sold 31 min after listing), so
// what matters is how fresh a listing is, not how cheap: newest first, auctions about to end before that,
// $0–2 "placeholder" prices last since their real price is unknown.
function rank(x) {
  if (x.priceCad <= 2) return 2e13 - Date.parse(x.postedAt || 0);
  const ends = x.endsAt ? Date.parse(x.endsAt) - Date.now() : Infinity;
  if (ends < 60 * 60e3) return ends - 1e13; // auction in its last hour: soonest first
  return -Date.parse(x.postedAt || 0);
}

// On battery, run light (one check at a time, no Marketplace browser): full speed drained the
// MacBook from 61% to 39% in 30 minutes. Checked at most once a minute.
let batt = { at: 0, on: false };
function onBattery() {
  if (Date.now() - batt.at < 60e3) return batt.on;
  try { batt = { at: Date.now(), on: /'Battery Power'/.test(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' })) }; } catch { batt.at = Date.now(); }
  return batt.on;
}

let fbBusy = false; // one Marketplace page at a time: the bot's browser has a single tab
let fbSweeping = false; // a sweep holds the browser profile; listing pages wait until it's done

async function drain(cfg) {
  trimQueue(cfg);
  if (Date.now() < judgePausedUntil) return;
  // Judge for a few minutes at most, then let the searches run again; otherwise a long queue starves them.
  const until = Date.now() + (cfg.drainMinutes ?? 3) * 60e3;
  // Several checks run side by side: most of a check is waiting on eBay/PPT/Claude, not CPU.
  const workers = onBattery() ? 1 : Math.max(1, cfg.judgeWorkers ?? 3);
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(cfg, until, i === 0, workers > 1 && i === workers - 1)));
  if (queue.length) log(`drain paused, ${queue.length} waiting`);
}

async function worker(cfg, until, lead, rawFirst = false) {
  while (queue.length && Date.now() < until && Date.now() >= judgePausedUntil) {
    if (lead) { await processOutbox(); processQuotes(cfg); await beat(cfg); }
    const hourAgo = Date.now() - 3600e3;
    while (judgedAt.length && judgedAt[0] < hourAgo) judgedAt.shift();
    while (sonnetAt.length && sonnetAt[0] < hourAgo) sonnetAt.shift();
    if (judgedAt.length >= (cfg.maxTriagePerHour || cfg.maxJudgementsPerHour)) { if (lead) log(`judge budget hit, ${queue.length} waiting`); return; }
    queue.sort((a, b) => rank(a) - rank(b));
    // One worker looks at raw singles first; the rest keep slabs first (raw never slows the slab hunt).
    queue.sort((a, b) => (rawFirst ? (b.raw ? 1 : 0) - (a.raw ? 1 : 0) : (a.raw ? 1 : 0) - (b.raw ? 1 : 0)));
    // When the hourly full-check cap is used up, local listings (which always need one) wait; eBay keeps going.
    const sonnetFull = sonnetAt.length >= cfg.maxJudgementsPerHour;
    // Over the sold-price budget pace: eBay slabs wait (newest first when it frees up) rather than be judged blind.
    const ebayOk = cfg.mode !== 'slabs' || pptPaced();
    const pick = queue.findIndex(x => (x.source === 'ebay' && ebayOk) || (x.source !== 'ebay' && !fbBusy && !(fbSweeping && x.source === 'facebook') && !(sonnetFull && cfg.deepLocal !== false)));
    if (pick < 0) {
      if (!ebayOk) { if (lead) log(`price-lookup budget paced, ${queue.length} waiting`); return; }
      if (sonnetFull && lead) log(`full-check cap reached, ${queue.length} local listings waiting`);
      if (sonnetFull || !fbBusy) return; // waiting on a sweep: let eBay polling run meanwhile
      await sleep(5000); continue; // another worker has the Marketplace tab
    }
    let l = queue.splice(pick, 1)[0];
    const fb = l.source === 'facebook';
    if (fb) fbBusy = true;
    judgedAt.push(Date.now());
    try {
      // Kijiji pages are a cheap HTTP fetch; Marketplace pages need a browser, so they're opened only for Stage 3.
      if (l.source === 'kijiji') l = await kijijiDetail(l);
      if (l.source === 'ebay' && cfg.mode !== 'slabs') l = await ebayDetail(cfg, l, await getFx());
      const r = l.raw
        ? await judgeRaw(cfg, l)
        : cfg.mode === 'slabs' && l.source === 'ebay'
        ? await judgeSlab(cfg, l)
        : await judge(cfg, l, { allowStage3: sonnetAt.length < cfg.maxJudgementsPerHour, detail: fb ? x => facebookDetail(cfg, x) : null });
      if (r.stage === 3) sonnetAt.push(Date.now());
      if (r.stage === 1) judgedAt.pop(); // priced from the title: no AI used, doesn't count toward the hourly cap
      const earlyAuction = /judged in its last hour/.test(r.ident?.summary || '');
      if (!earlyAuction) { seen.add(l.id); seen.save(); }
      stats.judged++;
      const rec = { at: new Date().toISOString(), photo: l.images?.[0] || null, stage: r.stage, aiCalls: aiUsage.calls, aiUsd: +aiUsage.usd.toFixed(4), id: l.id, url: l.url, title: l.title, price: l.priceCad, tier: r.tier, profit: +r.profit.toFixed(2), roi: +r.roi.toFixed(2), resale: +r.resale.toFixed(2), kind: r.ident.kind, fakeRisk: r.ident.fakeRisk, lines: r.lines, summary: r.ident.summary, askSeller: r.ident.askSeller, postedAt: l.postedAt || null, itemId: l.itemId || null };
      appendJsonl('judged', rec);
      log(`${r.tier.toUpperCase().padEnd(5)} s${r.stage} ${l.id} $${l.priceCad} → profit $${r.profit.toFixed(0)} (${Math.round(r.roi * 100)}%) ${l.title}`);
      // Shadow test: a raw "deal" is logged for review, never sent to the phone.
      if (r.tier !== 'pass' && l.raw && cfg.raw?.shadow !== false) {
        appendJsonl('raw-shadow', rec);
        log(`RAW-SHADOW ${r.tier} ${l.id} $${l.priceCad} → profit $${r.profit.toFixed(0)} ${l.title}`);
      } else if (r.tier !== 'pass') {
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
    } finally {
      if (fb) fbBusy = false;
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
    // Marketplace sweeps run in the background: a slow Chrome must never stall eBay checking.
    if (c.facebook?.enabled && now >= nextFacebook && inActiveHours(c) && !fbSweeping && !onBattery()) {
      fbSweeping = true;
      pollFacebook(c).finally(() => { fbSweeping = false; });
      nextFacebook = now + jitter(c.facebook.everyMinutes * 60e3, 0.3);
    }
    seen.save();
    if (stats.day !== today()) Object.assign(stats, { day: today(), judged: 0, deals: 0 });
    await beat(c);
    await retryPendingDeals();
    await processOutbox();
    processQuotes(c);
    if (ebayReady(c)) logOdds(c, getToken).catch(e => log('odds failed', e.message));
    if (ebayReady(c)) await trackOutcomes(c).catch(e => log('outcomes failed', e.message));
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
