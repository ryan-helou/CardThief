import fs from 'node:fs';
import path from 'node:path';
import { DATA, log } from './util.mjs';
import { ebayItemStatus } from './sources/ebay.mjs';
import { loadConfig } from './util.mjs';

// What happened to each eBay alert: still up, sold (and how fast), or pulled. Tells us how long
// steals last and, over weeks, which kinds of alerts were real. Checked every 15 minutes for 14 days.
const file = path.join(DATA, 'outcomes.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
let lastRun = 0;

export function outcomes() { return read(); }

export async function trackOutcomes(cfg) {
  if (Date.now() - lastRun < 15 * 60e3) return;
  lastRun = Date.now();
  let deals = [];
  try { deals = fs.readFileSync(path.join(DATA, 'deals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return; }
  const out = read();
  const since = Date.now() - 14 * 864e5;
  for (const d of deals) {
    if (!d.id.startsWith('ebay:') || Date.parse(d.at) < since) continue;
    const o = out[d.id] ??= { alertedAt: d.at, postedAt: d.postedAt || null, title: d.title, price: d.price, profit: d.profit, url: d.url, status: 'live' };
    if (o.status !== 'live') continue;
    try {
      const s = await ebayItemStatus(cfg, d.itemId || `v1|${d.id.slice(5)}|0`);
      o.checkedAt = new Date().toISOString();
      if (s.status === 'live') continue;
      o.status = s.status;
      o.endedAt = s.endedAt || o.checkedAt;
      o.minutesAfterAlert = Math.round((Date.parse(o.endedAt) - Date.parse(o.alertedAt)) / 60e3);
      if (o.postedAt) o.minutesAfterListing = Math.round((Date.parse(o.endedAt) - Date.parse(o.postedAt)) / 60e3);
      log(`outcome ${d.id}: ${o.status} ${o.minutesAfterAlert} min after the alert`);
    } catch (e) { log('outcome check failed', d.id, e.message); }
  }
  // Close alerts in the app that can't be bought any more, so "open deals" only lists live ones.
  for (const [id, o] of Object.entries(out)) {
    if (o.status !== 'live' && !o.closedInApp) {
      const why = o.status === 'sold' ? `sold ${o.minutesAfterAlert} min after the alert` : o.status === 'ended' ? 'listing ended' : 'listing removed';
      if (await closeInApp(id, why)) o.closedInApp = true;
    }
  }
  for (const d of deals) {
    if (d.id.startsWith('ebay:') || Date.parse(d.at) > Date.now() - 7 * 864e5) continue;
    const k = `local:${d.id}`;
    if (out[k]) continue;
    if (await closeInApp(d.id, 'a week old (local listings rarely last longer)')) out[k] = { status: 'closed', alertedAt: d.at, title: d.title, url: d.url, price: d.price, profit: d.profit };
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
}

async function closeInApp(id, why) {
  const cfg = loadConfig();
  if (!cfg.appUrl || !cfg.agentToken) return false;
  try {
    const res = await fetch(new URL('/api/agent/gone', cfg.appUrl), { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${cfg.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ id, why }) });
    return res.ok;
  } catch { return false; }
}
