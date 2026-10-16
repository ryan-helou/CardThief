// Re-judges recent Kijiji listings with the current local pipeline (photos, offers, second check).
import { loadConfig } from '../src/util.mjs';
import { searchKijiji, kijijiDetail } from '../src/sources/kijiji.mjs';
import { prefilter, judge } from '../src/judge.mjs';
const cfg = loadConfig();
const n = Number(process.argv[2] || 4);
const all = [];
for (const u of cfg.kijiji.searches) all.push(...(await searchKijiji(u)));
const list = all.filter(l => !prefilter(cfg, l) && /lot|collection|classeur|binder|cartes/i.test(l.title)).slice(0, n);
for (let l of list) {
  l = await kijijiDetail(l);
  const r = await judge(cfg, l).catch(e => ({ tier: 'error', ident: { summary: e.message }, lines: [] }));
  console.log(`\n${r.tier.toUpperCase()} ${r.action || ''} C$${l.priceCad} ${l.title.slice(0, 60)}  photos=${r.photos}  backed=${Math.round((r.backedShare || 0) * 100)}%  resale=C$${Math.round(r.resale || 0)} offer=C$${r.offer}`);
  console.log('   ', (r.ident?.summary || '').slice(0, 300));
  for (const x of (r.lines || []).slice(0, 6)) console.log('     -', x.label, 'C$' + x.marketCad, '|', x.basis.slice(0, 60));
}
process.exit(0);
