// Dry run: judge the newest raw singles with the raw judge, print verdicts. Nothing is sent anywhere.
import { loadConfig } from '../src/util.mjs';
import { getFx } from '../src/price.mjs';
import { searchEbay } from '../src/sources/ebay.mjs';
import { prefilter } from '../src/judge.mjs';
import { judgeRaw } from '../src/raw.mjs';
const cfg = loadConfig(), fx = await getFx();
const q = cfg.ebay.queries.find(x => x.raw);
const list = (await searchEbay(cfg, q, new Date(Date.now() - 6 * 3600e3), fx)).filter(l => !prefilter(cfg, l)).slice(0, Number(process.argv[2] || 25));
const tally = {};
for (const l of list) {
  const r = await judgeRaw(cfg, l).catch(e => ({ tier: 'error', ident: { summary: e.message } }));
  const why = (r.ident?.summary || '').replace(/\(.*$/, '').slice(0, 60);
  tally[why.split(':')[0].slice(0, 40)] = (tally[why.split(':')[0].slice(0, 40)] || 0) + 1;
  console.log(`${r.tier.padEnd(5)} C$${l.priceCad?.toFixed(0)}  ${l.title.slice(0, 55)}\n      ${(r.ident?.summary || '').slice(0, 200)}`);
}
process.exit(0);
