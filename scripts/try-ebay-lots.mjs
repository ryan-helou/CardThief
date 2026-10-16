// Judges the newest eBay lot listings with the lot pipeline. Nothing is sent anywhere.
import { loadConfig } from '../src/util.mjs';
import { getFx } from '../src/price.mjs';
import { searchEbay, ebayDetail } from '../src/sources/ebay.mjs';
import { prefilter, judge } from '../src/judge.mjs';
const cfg = loadConfig(), fx = await getFx();
const q = cfg.ebay.queries.find(x => x.lot && !x.endWithinMin);
const list = (await searchEbay(cfg, q, new Date(Date.now() - 3 * 3600e3), fx)).filter(l => !prefilter(cfg, l)).slice(0, Number(process.argv[2] || 8));
for (const l of list) {
  const r = await judge(cfg, l, { detail: x => ebayDetail(cfg, x, fx) }).catch(e => ({ tier: 'error', stage: '-', ident: { summary: e.message }, lines: [] }));
  console.log(`\n${r.tier.toUpperCase()} s${r.stage} ${r.action || ''} C$${l.priceCad?.toFixed(0)}+${l.shippingCad?.toFixed(0)} ${l.title.slice(0, 60)}  resale=C$${Math.round(r.resale || 0)}`);
  console.log('   ', (r.ident?.summary || '').slice(0, 220));
}
process.exit(0);
