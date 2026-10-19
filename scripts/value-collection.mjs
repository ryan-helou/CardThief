// Values a whole collection from photos: basketball (or any sport), Yu-Gi-Oh, Lego, Pokémon.
//   node scripts/value-collection.mjs ~/Desktop/basketball basketball
// Each photo is read on its own at full size (9-card pages work best). Every item worth roughly
// US$2+ is priced: Yu-Gi-Oh by set code (YGOPRODeck, TCGplayer prices), everything else from live
// eBay asks (the cheaper end, since asks run above sold prices). Writes <folder>/_valuation/
// with a CSV, a summary and the list of items that need a close-up photo.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, fetchJson } from '../src/util.mjs';
import { runClaude } from '../src/judge.mjs';
import { getToken } from '../src/sources/ebay.mjs';
import { getFx } from '../src/price.mjs';

const [dirArg, kindArg] = process.argv.slice(2);
if (!dirArg) { console.error('usage: node scripts/value-collection.mjs <folder> [basketball|yugioh|lego|pokemon|sports]'); process.exit(1); }
const dir = path.resolve(dirArg.replace(/^~/, process.env.HOME));
const kind = kindArg || path.basename(dir).toLowerCase();
const cfg = loadConfig();
const out = path.join(dir, '_valuation');
fs.mkdirSync(out, { recursive: true });

const ITEM = {
  type: 'object',
  properties: {
    position: { type: 'string' }, // "top-left", "middle", "row 2 col 3"
    label: { type: 'string' },
    query: { type: 'string' },
    setCode: { type: ['string', 'null'] },
    year: { type: ['string', 'null'] },
    variant: { type: ['string', 'null'] },
    serial: { type: ['string', 'null'] },
    grade: { type: ['string', 'null'] },
    condition: { type: 'string' },
    quantity: { type: 'integer' },
    estUsd: { type: 'number' },
    closeup: { type: 'boolean' },
    closeupWhy: { type: ['string', 'null'] },
  },
  required: ['position', 'label', 'query', 'condition', 'quantity', 'estUsd', 'closeup'],
};
const SCHEMA = {
  type: 'object',
  properties: { itemsVisible: { type: 'integer' }, items: { type: 'array', items: ITEM }, cheapCount: { type: 'integer' }, notes: { type: 'string' } },
  required: ['itemsVisible', 'items', 'cheapCount'],
};

const GUIDE = {
  sports: `Sports cards. For each card worth roughly US$2+: player, year, brand and set (Prizm, Select, Optic, Topps Chrome, Fleer, Upper Deck…), card number, rookie (RC logo), the parallel (Silver, Holo, Refractor, Mojo, colored border; "base" if none), serial numbering (e.g. 23/99) if visible, autograph or relic/patch, and graded slab label if any. query = a tight eBay search, e.g. "2019 Prizm Ja Morant 249 Silver RC". Commons and non-stars without a parallel are worth under US$2: count them in cheapCount, don't list them.
closeup = true when the value hinges on something the photo can't settle: a possible parallel vs base (shine is hard to see), a serial number on the back, an autograph's authenticity, or any card that could be worth US$25+.`,
  yugioh: `Yu-Gi-Oh cards. For each card worth roughly US$2+ (Ultra, Secret, Ultimate, Ghost, Starlight, Collector's, Quarter Century rares, and old 1st Edition rares): card name, setCode exactly as printed under the art on the right (e.g. LOB-EN001), rarity as variant, "1st Edition" or "Unlimited" in variant if readable. query = name + set code + rarity. Commons and rares with a flat name are under US$2: count them in cheapCount.
closeup = true when the set code or edition isn't readable, or the card could be worth US$25+.`,
  lego: `Lego. For each set, box, or minifigure: set number (4–6 digits on the box or instructions) if visible, set name and theme, sealed / complete with box / built without box / incomplete, and for minifigures the character and theme. query = "lego <set number> <name>" or "lego minifigure <name> <theme>". Loose bulk bricks: one item labelled "bulk bricks" with an estimated weight in the label.
closeup = true when the set number isn't visible, completeness is unclear, or it could be worth US$50+.`,
  pokemon: `Pokémon cards. For each card worth roughly US$2+: name, set, collector number and set total, variant (holo/reverse/1st Edition/shadowless), graded label if any. query = "pokemon <name> <number>/<total> <set>". Commons/uncommons under US$2: count in cheapCount.
closeup = true when the printing or condition decides the value, or it could be worth US$25+.`,
};
const guide = GUIDE[kind] || (/(basket|hockey|baseball|football|soccer|sport)/.test(kind) ? GUIDE.sports : GUIDE.sports);
const PROMPT = (f, i, n) => `Photo ${i} of ${n} (${f}) from Ryan's own ${kind} collection, being valued to sell.
${guide}
condition: what you can see (NM/LP/MP/HP/damaged, or "sealed"/"unknown"). estUsd: your best estimate of what ONE sells for on eBay (sold, not asking), in USD. position: where it is in the photo so Ryan can find it. Never invent a card you can't actually read; if a card is unreadable but might matter, list it with closeup=true.`;

// ---------- pricing ----------
const fx = await getFx();
const cache = new Map();
async function ygoPrice(it) {
  if (!it.setCode) return null;
  try {
    const r = await fetchJson(`https://db.ygoprodeck.com/api/v7/cardsetsinfo.php?setcode=${encodeURIComponent(it.setCode.toUpperCase())}`);
    const p = Number(r.set_price);
    return p > 0 ? { usd: p, basis: `YGOPRODeck ${r.set_code} ${r.set_rarity} (TCGplayer)` } : null;
  } catch { return null; }
}
const CATS = { lego: '220', yugioh: '2536', pokemon: '183454', sports: '212' };
async function ebayPrice(it) {
  const q = it.query.trim();
  if (cache.has(q)) return cache.get(q);
  const t = await getToken(cfg.ebayKeys);
  const cat = CATS[kind] || CATS.sports;
  const params = new URLSearchParams({ q, category_ids: cat, limit: '50', filter: 'buyingOptions:{FIXED_PRICE}' });
  let res;
  try {
    res = await fetchJson(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, { headers: { authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
  } catch { return null; }
  // Keep listings that mention the distinctive words of the query (player/set/number), not lots or reprints.
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2 || /^\d+$/.test(w));
  const gradedQ = /\b(psa|bgs|sgc|cgc)\b/i.test(q);
  const prices = (res.itemSummaries || [])
    .filter(x => words.filter(w => x.title.toLowerCase().includes(w)).length >= Math.ceil(words.length * 0.7))
    .filter(x => !/\blot\b|\blots\b|bundle|reprint|custom|proxy|\brp\b|you pick|pick your/i.test(x.title))
    .filter(x => gradedQ || !/\b(psa|bgs|sgc|cgc)\s*\d/i.test(x.title))
    .map(x => (x.price?.currency === 'USD' ? Number(x.price.value) : Number(x.price?.value) / (fx.USD || 1.38)))
    .filter(n => n > 0)
    .sort((a, b) => a - b);
  // Asking prices run above what actually sells: take the lower quartile, never the median.
  const v = prices.length ? { usd: prices[Math.floor((prices.length - 1) / 4)], basis: `eBay asks: ${prices.length} listings, lower quartile` + (prices.length < 3 ? ' (few listings, rough)' : '') } : null;
  cache.set(q, v);
  return v;
}

// ---------- read every photo ----------
const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|heic|webp)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
console.log(`${files.length} photos in ${dir} (${kind})`);
const rows = [];
let cheap = 0, visible = 0;
for (let i = 0; i < files.length; i += 3) {
  const batch = await Promise.all(files.slice(i, i + 3).map(async (f, k) => {
    const one = path.join(out, `.one_${i + k}`);
    fs.mkdirSync(one, { recursive: true });
    fs.copyFileSync(path.join(dir, f), path.join(one, f));
    try {
      return { f, r: await runClaude(cfg, PROMPT(f, i + k + 1, files.length), one, { model: cfg.judgeModel, schema: SCHEMA, system: 'You identify collectibles in photos for a reseller. Be exact; skip what you cannot read.', maxPx: 1600 }) };
    } catch (e) { console.log(`  ${f}: read failed (${e.message.slice(0, 80)})`); return { f, r: null }; }
    finally { fs.rmSync(one, { recursive: true, force: true }); }
  }));
  for (const { f, r } of batch) {
    if (!r) continue;
    cheap += r.cheapCount || 0; visible += r.itemsVisible || 0;
    for (const it of r.items) {
      const p = (kind === 'yugioh' ? await ygoPrice(it) : null) || (await ebayPrice(it));
      // Our live price wins; fall back to the model's estimate when nothing matched.
      const usd = p?.usd ?? it.estUsd;
      rows.push({ photo: f, ...it, usd: +usd.toFixed(2), cad: +(usd * (fx.USD || 1.38)).toFixed(2), basis: p?.basis || 'Claude estimate (no live match)', total: +(usd * (it.quantity || 1)).toFixed(2) });
    }
    console.log(`  ${f}: ${r.items.length} worth listing, ${r.cheapCount} cheap`);
  }
}

// ---------- write results ----------
rows.sort((a, b) => b.total - a.total);
const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const cols = ['photo', 'position', 'label', 'year', 'variant', 'serial', 'setCode', 'grade', 'condition', 'quantity', 'usd', 'cad', 'total', 'basis', 'closeup', 'closeupWhy', 'query'];
fs.writeFileSync(path.join(out, 'items.csv'), [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
const sum = rows.reduce((a, r) => a + r.total, 0);
const cheapUsd = cheap * (kind === 'lego' ? 1 : 0.15);
const close = rows.filter(r => r.closeup).sort((a, b) => b.usd - a.usd); // most valuable first: those are the close-ups worth taking
const md = [
  `# ${kind} collection value`,
  `${files.length} photos, about ${visible} items seen; ${rows.length} worth US$2+ listed, ${cheap} cheap ones counted.`,
  ``,
  `**Listed items:** US$${sum.toFixed(0)} (C$${(sum * (fx.USD || 1.38)).toFixed(0)})  `,
  `**Cheap items (bulk):** about US$${cheapUsd.toFixed(0)}  `,
  `**Total, market value:** about US$${(sum + cheapUsd).toFixed(0)} (C$${((sum + cheapUsd) * (fx.USD || 1.38)).toFixed(0)}). Selling it all nets roughly 70–80% of that after fees and shipping.`,
  ``,
  `## Top 25`,
  ...rows.slice(0, 25).map(r => `- US$${r.total} · ${r.label}${r.quantity > 1 ? ` ×${r.quantity}` : ''} (${r.condition}) — ${r.basis} [${r.photo}, ${r.position}]`),
  ``,
  `## Close-ups needed (${close.length})`,
  ...close.map(r => `- ${r.photo}, ${r.position}: ${r.label} — ${r.closeupWhy || 'check it'}`),
].join('\n');
fs.writeFileSync(path.join(out, 'summary.md'), md);
console.log('\n' + md);
process.exit(0);
