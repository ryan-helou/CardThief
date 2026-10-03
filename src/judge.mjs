import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, UA, log } from './util.mjs';
import { priceCard, getFx } from './price.mjs';

// ---------- 1. Free prefilter: drop anything that obviously isn't Pokémon cards ----------
export function prefilter(cfg, l) {
  const text = `${l.title} ${l.description}`.toLowerCase();
  // Facebook search tiles carry only a short title, and the queries already ask for cards.
  const fb = l.source === 'facebook';
  if (!fb && !/pok[eé]mon|pokemon/.test(text)) return 'not pokemon';
  if (new RegExp(cfg.titleExclude, 'i').test(l.title)) return 'excluded item type';
  if (!fb && !new RegExp(cfg.titleMustMatch, 'i').test(text)) return 'no card keywords';
  if (l.priceCad == null) return l.priceType === 'CONTACT' ? 'no price (contact)' : 'no price';
  if (l.priceCad <= 0) return 'free/zero price';
  if (l.priceCad > cfg.maxBuyCad) return `over max buy ($${l.priceCad})`;
  return null;
}

// ---------- 2. Claude reads the listing + photos and lists what's in it ----------
const SCHEMA = {
  type: 'object',
  properties: {
    isPokemonCards: { type: 'boolean' },
    kind: { type: 'string', enum: ['single', 'lot', 'graded', 'sealed', 'mixed', 'other'] },
    language: { type: 'string', enum: ['en', 'fr', 'jp', 'mixed', 'other', 'unknown'] },
    fakeRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
    fakeReasons: { type: 'string' },
    totalCardCount: { type: ['integer', 'null'] },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          number: { type: ['string', 'null'] },
          setName: { type: ['string', 'null'] },
          setTotal: { type: ['integer', 'null'] },
          variant: { type: 'string', enum: ['normal', 'holo', 'reverse', '1st', 'unknown'] },
          grade: { type: ['string', 'null'] },
          condition: { type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG', 'unknown'] },
          estUsd: { type: ['number', 'null'] },
          quantity: { type: 'integer' },
        },
        required: ['name', 'variant', 'condition', 'estUsd', 'quantity'],
      },
    },
    sealed: {
      type: 'array',
      items: { type: 'object', properties: { product: { type: 'string' }, estUsd: { type: ['number', 'null'] }, quantity: { type: 'integer' } }, required: ['product', 'estUsd', 'quantity'] },
    },
    hiddenUpside: { type: 'string' },
    askSeller: { type: 'string' },
    confidence: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['isPokemonCards', 'kind', 'language', 'fakeRisk', 'cards', 'sealed', 'confidence', 'summary', 'totalCardCount'],
};

const PROMPT = l => `You are valuing a second-hand listing for a Pokémon card flipper in Montréal. He buys underpriced cards and resells them on eBay.

LISTING (${l.source})
Title: ${l.title}
Price: ${l.priceCad != null ? `C$${l.priceCad.toFixed(2)}` : 'none'}${l.priceNative ? ` (${l.priceNative})` : ''}${l.shippingCad ? ` + C$${l.shippingCad.toFixed(2)} shipping` : ''}
Location: ${l.location || '?'}${l.condition ? `\nCondition: ${l.condition}` : ''}${l.bids != null ? `\nBids: ${l.bids}, ends ${l.endsAt}` : ''}
Description:
${(l.description || '').slice(0, 2500)}

PHOTOS: read every image file in ${l.imgDir} with the Read tool before answering. Study them closely: card names, set symbols, collector numbers (e.g. 199/165), holo vs reverse holo, slabs and their labels, sealed products, condition (whitening, creases, bends).

Return:
- cards: every card worth roughly US$2+ that you can actually see or that the text names specifically. Use the ENGLISH card name (translate French names, e.g. "Dracaufeu" → "Charizard"), the collector number and set total if readable, set name if known. estUsd = your best estimate of its current raw near-mint TCGplayer market price in USD (or the graded price if slabbed, with grade like "PSA 10"). quantity for duplicates. Don't list commons/uncommons individually.
- totalCardCount: total cards in the listing (stated or estimated), null if unknown.
- sealed: sealed products with estUsd each.
- fakeRisk: high for proxies/"custom"/"orica"/metal/gold-foil novelty cards, fake-looking fonts/colours, or prices far too good to be true.
- hiddenUpside: what valuable cards might plausibly be in the parts not photographed (one sentence, or "").
- askSeller: the one question/photo request that would most change the value (in French if the listing is French).
- summary: one plain sentence on what this is and whether it looks underpriced.
Be conservative: if you can't read a card, don't guess an expensive one.`;

async function downloadImages(l) {
  const dir = path.join(DATA, 'img', l.id.replace(/[^a-z0-9]+/gi, '_'));
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const url of l.images.slice(0, 8)) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (!res.ok) continue;
      const type = res.headers.get('content-type') || '';
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      fs.writeFileSync(path.join(dir, `${++n}.${ext}`), Buffer.from(await res.arrayBuffer()));
    } catch {}
  }
  return { dir, n };
}

function runClaude(cfg, prompt, imgDir) {
  const cwd = path.join(DATA, 'judge');
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    '-p', '--model', cfg.judgeModel, '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA),
    '--allowedTools', 'Read', '--add-dir', imgDir,
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    // Clean env: when launched from inside a Claude Code session, its host variables would hijack the child's auth.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_BASE_URL)/.test(k)));
    const p = spawn(cfg.claudeBin || 'claude', args, { cwd, env });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude timed out')); }, 240_000);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      clearTimeout(timer);
      try {
        const o = JSON.parse(out);
        if (o.is_error) return reject(new Error(`claude: ${o.result || o.subtype}`));
        const s = o.structured_output ?? JSON.parse(String(o.result).replace(/^```(json)?|```$/g, '').trim());
        resolve(s);
      } catch (e) {
        reject(new Error(`claude exit ${code}: ${(err || out).slice(0, 300)}`));
      }
    });
    p.stdin.end(prompt);
  });
}

// ---------- 3. Price what Claude found and work out the flip profit ----------
export async function value(cfg, l, ident) {
  const m = cfg.money;
  const fx = await getFx();
  const langFactor = { en: 1, fr: 0.7, jp: 0.8, mixed: 0.85, other: 0.5, unknown: 0.85 }[ident.language] ?? 0.85;
  const netSingle = cad => (cad >= m.singleMinCad ? cad * (1 - m.ebaySellFee) - m.ebayOrderFee - m.singleShipCad : cad * m.cheapCardFactor);

  const lines = [];
  let counted = 0;
  let resale = 0;
  for (const c of ident.cards) {
    const qty = Math.max(1, c.quantity || 1);
    counted += qty;
    let market = null, basis = '';
    if (!c.grade) {
      const p = await priceCard(c);
      if (p) { market = p.cad; basis = p.basis + (p.ambiguous ? ' (cheapest match)' : ''); }
    }
    if (market == null && c.estUsd) { market = c.estUsd * fx.USD; basis = 'Claude estimate'; }
    if (market == null) continue;
    const condFactor = c.grade ? 1 : { NM: 1, LP: 0.8, MP: 0.6, HP: 0.4, DMG: 0.25, unknown: m.rawConditionHaircut }[c.condition] ?? m.rawConditionHaircut;
    const adj = market * condFactor * (c.grade ? 1 : langFactor);
    const net = netSingle(adj) * qty;
    resale += Math.max(0, net);
    lines.push({ label: `${qty > 1 ? qty + '× ' : ''}${c.name}${c.number ? ' ' + c.number : ''}${c.grade ? ' ' + c.grade : ''}`, marketCad: +(market * qty).toFixed(2), netCad: +net.toFixed(2), basis });
  }
  for (const s of ident.sealed || []) {
    if (!s.estUsd) continue;
    const qty = Math.max(1, s.quantity || 1);
    const cad = s.estUsd * fx.USD;
    const net = (cad * (1 - m.ebaySellFee) - m.ebayOrderFee - 12) * qty;
    resale += Math.max(0, net);
    lines.push({ label: `${qty > 1 ? qty + '× ' : ''}${s.product}`, marketCad: +(cad * qty).toFixed(2), netCad: +net.toFixed(2), basis: 'Claude estimate (sealed)' });
  }
  const bulk = Math.max(0, (ident.totalCardCount || 0) - counted) * m.bulkCadPerCard;
  resale += bulk;

  const tax = l.source === 'ebay' ? (l.priceCad + (l.shippingCad || 0)) * m.buyerTaxOnline : 0;
  const cost = l.priceCad + (l.shippingCad || 0) + tax;
  const profit = resale - cost;
  const roi = cost > 0 ? profit / cost : 0;
  const marketTotal = lines.reduce((a, x) => a + x.marketCad, 0);

  let tier = 'pass';
  const { steal, good } = cfg.deal;
  if (ident.fakeRisk !== 'high' && ident.isPokemonCards) {
    if (profit >= steal.minProfitCad && roi >= steal.minRoi) tier = 'steal';
    else if (profit >= good.minProfitCad && roi >= good.minRoi) tier = 'good';
  }
  return { tier, cost, resale, profit, roi, marketTotal, bulk, lines };
}

export async function judge(cfg, l) {
  const { dir, n } = await downloadImages(l);
  const ident = await runClaude(cfg, PROMPT({ ...l, imgDir: dir }), dir);
  const v = await value(cfg, l, ident);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ident, ...v, photos: n };
}
