import { execFile } from 'node:child_process';
import { loadConfig, log } from './util.mjs';

const money = n => `$${Math.round(n)}`;

export function formatDeal(l, r) {
  const head = r.tier === 'steal' ? '🔥 STEAL' : r.tier === 'good' ? '✅ Good deal' : 'Deal';
  const title = `${head} +${money(r.profit)} · ${l.title}`.slice(0, 120);
  const top = [...r.lines].sort((a, b) => b.marketCad - a.marketCad).slice(0, 5);
  const msg = [
    `${l.source.toUpperCase()} · ${money(r.cost)} all-in → ~${money(r.resale)} after eBay fees · ROI ${Math.round(r.roi * 100)}%`,
    l.location ? `📍 ${l.location}` : '',
    l.bids != null ? `⏱ ${l.bids} bids, ends ${new Date(l.endsAt).toLocaleString('en-CA')}` : '',
    ...top.map(x => `• ${x.label}: ${money(x.marketCad)} (${x.basis})`),
    r.bulk ? `• bulk: ${money(r.bulk)}` : '',
    r.ident.fakeRisk !== 'low' ? `⚠️ fake risk ${r.ident.fakeRisk}: ${r.ident.fakeReasons || ''}` : '',
    r.ident.summary,
    r.ident.hiddenUpside ? `💡 ${r.ident.hiddenUpside}` : '',
    r.ident.askSeller ? `❓ Ask: ${r.ident.askSeller}` : '',
  ].filter(Boolean).join('\n');
  return { title, msg };
}

export async function push({ title, msg, url, image, priority = 4, tags = [] }) {
  const cfg = loadConfig();
  if (cfg.ntfyTopic) {
    try {
      const res = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: cfg.ntfyTopic, title, message: msg, priority, tags, click: url, attach: image, actions: url ? [{ action: 'view', label: 'Open listing', url }] : undefined }),
      });
      if (!res.ok) log('ntfy failed', res.status, await res.text());
    } catch (e) {
      log('ntfy error', e.message);
    }
  }
  // Mac banner too, so a deal is visible even if the phone is away.
  const esc = s => String(s).replace(/["\\]/g, ' ').slice(0, 200);
  execFile('osascript', ['-e', `display notification "${esc(msg.split('\n')[0])}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

if (process.argv.includes('--test')) {
  await push({ title: '🔥 CardThief test', msg: 'If you can read this on your phone, alerts work.', url: 'https://www.kijiji.ca', tags: ['white_check_mark'] });
  console.log('sent test alert to topic', loadConfig().ntfyTopic || '(no ntfyTopic set — Mac banner only)');
}
