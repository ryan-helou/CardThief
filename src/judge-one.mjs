// Judge a single Kijiji listing by URL, without alerting: npm run judge -- <kijiji url>
import { loadConfig } from './util.mjs';
import { kijijiDetail } from './sources/kijiji.mjs';
import { prefilter, judge } from './judge.mjs';
import { formatDeal } from './notify.mjs';

const url = process.argv[2];
const id = url?.match(/\/(\d+)(\?|$)/)?.[1];
if (!id) { console.error('usage: npm run judge -- <kijiji listing url>'); process.exit(1); }
const cfg = loadConfig();
const l = await kijijiDetail({ source: 'kijiji', id: `kijiji:${id}`, url, images: [] });
console.log('prefilter:', prefilter(cfg, l) || 'pass');
const r = await judge(cfg, l);
const { title, msg } = formatDeal(l, r);
console.log(`\n[${r.tier}] ${title}\n${msg}\n`);
console.log(JSON.stringify(r.ident, null, 1));
