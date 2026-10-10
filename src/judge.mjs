import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DATA, UA, log } from './util.mjs';
import { priceCard, getFx } from './price.mjs';
import { pptPrice, pptAvailable } from './ppt.mjs';
import { ROOT } from './util.mjs';

// ---------- 1. Free prefilter: drop anything that obviously isn't Pokémon cards ----------
export function prefilter(cfg, l) {
  const text = `${l.title} ${l.description}`.toLowerCase();
  // Facebook search tiles carry only a short title, and the queries already ask for cards.
  const fb = l.source === 'facebook';
  if (!fb && !/pok[eé]mon|pokemon/.test(text)) return 'not pokemon';
  if (new RegExp(cfg.titleExclude, 'i').test(l.title)) return 'excluded item type';
  if (/[ée]chang|\btrade\b|\bswap\b/i.test(l.title) && l.priceCad <= 5) return 'trade post (placeholder price)';
  if (/\b(vendu|sold|r[ée]serv[ée]|pending)\b/i.test(l.title)) return 'already sold';
  if (/\b(recherche|cherche|wanted|looking for|j'ach[eè]te|achat|buying|besoin d)/i.test(l.title)) return 'wanted/buyer post';
  if (!fb && !new RegExp(cfg.titleMustMatch, 'i').test(text)) return 'no card keywords';
  if (l.priceCad == null) return l.priceType === 'CONTACT' ? 'no price (contact)' : 'no price';
  if (l.priceCad <= 0) return 'free/zero price';
  const auction = l.buyingOptions?.includes('AUCTION') && !l.buyingOptions?.includes('FIXED_PRICE');
  if (!auction && l.priceCad < (cfg.minPriceCad ?? 20)) return `under C$${cfg.minPriceCad ?? 20} ($${l.priceCad})`;
  if (l.priceCad > cfg.maxBuyCad) return `over max buy ($${l.priceCad})`;
  // eBay from outside Canada: only lots survive the 20–35% cross-border costs.
  if (l.source === 'ebay' && ['JP', 'CN', 'KR', 'HK', 'TW'].includes(l.country)) return 'ships from Asia';
  if (l.source === 'ebay' && l.country !== 'CA' && !auction && !isLot(l.title)) return 'foreign eBay single';
  return null;
}

const isLot = t => /\b(lot|bundle|collection|binder|classeur|cartable|bulk|vrac|cartes?\s+pok|\d{2,}\s*(cards|cartes|pcs))\b/i.test(t);
const isSealed = t => /\b(etb|elite trainer|booster box|booster bundle|display|tin|blister|scell[ée]|sealed|neuf)\b/i.test(t);

// ---------- Stage 1: identify a single card from the title, no AI ----------
const NOISE = /\b(pok[eé]mon|tcg|card|carte|cards|cartes|holo|reverse|rare|ultra|secret|full art|alt art|sir|sar|ir|near mint|nm|lp|mint|english|anglais|fr|en|psa|cgc|bgs|sgc|tag|ace|graded|slab|the|de|du|la|le|\d{4})\b/gi;
export function parseTitle(t) {
  const grade = t.match(/\b(PSA|CGC|BGS|SGC|TAG|ACE)\s*-?\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5)\b/i);
  const num = t.match(/\b(\d{1,3})\s*\/\s*(\d{2,3})\b/) || t.match(/\b((?:SV|SWSH|SM|XY|BW)P?\s?-?\d{2,3})\b/i);
  const lang = /japan|japon|\bjp\b|jpn/i.test(t) ? 'jp' : /\bfr\b|fran[cç]ais|french/i.test(t) ? 'fr' : 'en';
  let name = null;
  if (num) {
    const before = t.slice(0, num.index).replace(NOISE, ' ').replace(/[^\p{L}\s'&.-]/gu, ' ').replace(/\s+/g, ' ').trim();
    name = before.split(' ').slice(-3).join(' ') || null; // card names sit right before the number
  }
  const variant = /1st\s*ed|1[eè]re\s*[ée]d|first edition/i.test(t) ? '1st' : /reverse/i.test(t) ? 'reverse' : 'unknown';
  return { variant, name, number: num ? (num[2] ? `${num[1]}/${num[2]}` : num[1]) : null, setTotal: num?.[2] ? Number(num[2]) : null, grade: grade ? `${grade[1].toUpperCase()} ${grade[2]}` : null, language: lang };
}

async function stage1(cfg, l) {
  if (isLot(l.title) || isSealed(l.title)) return null;
  const p = parseTitle(l.title);
  if (!p.name || !p.number || p.language !== 'en') return null; // the free catalog is English-only
  // Try the last 3, 2, then 1 words before the number as the card name.
  const words = p.name.split(' ');
  for (let k = Math.min(3, words.length); k >= 1; k--) {
    const card = { name: words.slice(-k).join(' '), number: p.number, setTotal: p.setTotal, grade: p.grade, variant: p.variant, condition: 'unknown', estUsd: null, quantity: 1 };
    const ident = { isPokemonCards: true, kind: p.grade ? 'graded' : 'single', language: p.language, fakeRisk: 'low', cards: [card], sealed: [], totalCardCount: 1, realAskingPriceCad: null, priceScope: 'whole_listing', verdict: 'underpriced', summary: `Priced from the title: ${card.name} ${card.number}${card.grade ? ' ' + card.grade : ''}.` };
    const v = await value(cfg, l, ident, { pptOk: Boolean(p.grade), strict: true });
    if (v.lines.length) return { ident, ...v };
  }
  return null;
}

// ---------- Stage 2: Haiku glance (title + 1 photo) ----------
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: { worthALook: { type: 'boolean' }, roughResaleCad: { type: ['number', 'null'] }, reason: { type: 'string' } },
  required: ['worthALook', 'roughResaleCad', 'reason'],
};
const TRIAGE = (l, cost, img) => `Pokémon card listing near Montréal. Buyer flips on eBay.
Title: ${l.title}
All-in cost: C$${cost.toFixed(0)}
Description: ${(l.description || '').slice(0, 600)}
${img ? 'Photo attached.' : 'No photo.'}
Could this plausibly resell for at least 1.3× the all-in cost after eBay fees? Be skeptical: most listings are fairly priced. Give a rough resale value in CAD.`;

// ---------- Stage 3: Claude reads the listing + photos and lists what's in it ----------
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
    realAskingPriceCad: { type: ['number', 'null'] },
    priceScope: { type: 'string', enum: ['whole_listing', 'per_item', 'catalog'] },
    verdict: { type: 'string', enum: ['underpriced', 'fair', 'overpriced', 'unclear'] },
    hiddenUpside: { type: 'string' },
    askSeller: { type: 'string' },
    confidence: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['isPokemonCards', 'kind', 'language', 'fakeRisk', 'cards', 'sealed', 'confidence', 'summary', 'totalCardCount', 'realAskingPriceCad', 'priceScope', 'verdict'],
};

const PROMPT = l => `You are valuing a second-hand listing for a Pokémon card flipper in Montréal. He buys underpriced cards and resells them on eBay.

LISTING (${l.source})
Title: ${l.title}
Price: ${l.priceCad != null ? `C$${l.priceCad.toFixed(2)}` : 'none'}${l.shippingCad ? ` + C$${l.shippingCad.toFixed(2)} shipping to H7T 2W7${l.shippingEstimated ? ' (estimated)' : ''}` : ''}
Location: ${l.location || '?'}${l.condition ? `\nCondition: ${l.condition}` : ''}${l.bids != null ? `\nBids: ${l.bids}, ends ${l.endsAt}` : ''}
Description:
${(l.description || '').slice(0, 2500)}

PHOTOS: attached below; study every one before answering.${l.hint ? `\nTitle-based estimate to verify: ${l.hint}` : ''}\nFollow your checklist (Stage 3) and return the fields below. All money is CAD except per-card estUsd.

Return:
- cards: every card worth roughly US$2+ that you can actually see or that the text names specifically. Use the ENGLISH card name (translate French names, e.g. "Dracaufeu" → "Charizard"), the collector number and set total if readable, set name if known. estUsd = your best estimate of its current raw near-mint TCGplayer market price in USD (or the graded price if slabbed, with grade like "PSA 10"). quantity for duplicates. Don't list commons/uncommons individually.
- totalCardCount: total cards in the listing (stated or estimated), null if unknown.
- sealed: sealed products with estUsd each.
- fakeRisk: high for proxies/"custom"/"orica"/metal/gold-foil novelty cards, fake-looking fonts/colours, or prices far too good to be true.
- realAskingPriceCad: Facebook/Kijiji sellers often list at $1 or $0 as a placeholder. If the listed price looks like a placeholder or differs from the real asking price stated in the description or photos, give the real total asking price in CAD (if it's per card, multiply out for the whole listing). If the stated price is real, return null.
- priceScope: "whole_listing" if the price buys everything shown; "per_item" if it's a price for each item ("40$ each", "5$ chaque"); "catalog" for shop/catalog posts where items are priced individually or by "market value" and no single price buys the lot.
- verdict: your honest call, comparing what the buyer would pay against what the cards resell for: "underpriced" only if he'd clearly make money flipping it.
- hiddenUpside: what valuable cards might plausibly be in the parts not photographed (one sentence, or "").
- askSeller: the one question/photo request that would most change the value (in French if the listing is French).
- summary: one plain sentence on what this is and whether it looks underpriced.
Be conservative: if you can't read a card, don't guess an expensive one.`;

async function downloadImages(l, max = 4) {
  const dir = path.join(DATA, 'img', l.id.replace(/[^a-z0-9]+/gi, '_'));
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const url of l.images.slice(0, max)) {
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

// Lean call: our own system prompt and no tools, so each judgement doesn't pay
// for Claude Code's ~20k-token default setup (measured 2026-10-09: ~21k → ~1.8k tokens).
const SKILL = path.join(ROOT, '.claude/skills/mint-deal-check/SKILL.md');
export const aiUsage = { calls: 0, usd: 0 };
// Photos go inline (base64, downsized with macOS sips), so there is no Read-tool round trip.
function encodeImages(dir, maxPx) {
  if (!dir) return [];
  return fs.readdirSync(dir).sort().map(f => {
    const src = path.join(dir, f), out = path.join(dir, `small-${f.replace(/\.\w+$/, '')}.jpg`);
    try { execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', String(maxPx), src, '--out', out], { stdio: 'ignore' }); } catch { return null; }
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(out).toString('base64') } };
  }).filter(Boolean);
}

function runClaude(cfg, prompt, imgDir, { model, schema, system, maxPx = 1024 }) {
  const cwd = path.join(DATA, 'judge');
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    '-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema), '--tools', '', '--system-prompt', system,
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
  ];
  const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }, ...encodeImages(imgDir, maxPx)] } };
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
      const o = out.split('\n').filter(Boolean).map(x => { try { return JSON.parse(x); } catch { return null; } }).find(x => x?.type === 'result');
      if (!o) return reject(new Error(`claude exit ${code}: ${(err || out).slice(-300)}`));
      if (o.is_error) return reject(new Error(`claude: ${o.result || o.subtype}`));
      aiUsage.calls++; aiUsage.usd += o.total_cost_usd || 0;
      try { resolve(o.structured_output ?? JSON.parse(String(o.result).replace(/^```(json)?|```$/g, '').trim())); }
      catch { reject(new Error(`claude: no structured output: ${String(o.result).slice(0, 200)}`)); }
    });
    // If claude exits before reading everything, the write fails with EPIPE; the close handler reports it.
    p.stdin.on('error', () => {});
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.stdin.end(JSON.stringify(message) + '\n');
  });
}

// ---------- 3. Price what Claude found and work out the flip profit ----------
export async function value(cfg, l, ident, { pptOk = true, strict = false } = {}) {
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
      const p = await priceCard(c, { strict });
      if (p) { market = p.cad; basis = p.basis + (p.ambiguous ? ' (cheapest match)' : ''); }
    }
    // Real eBay sold prices for slabs, and for raw cards worth enough to matter (free plan ≈ 40 lookups/day).
    if (pptOk && (c.grade || (market ?? (c.estUsd || 0) * fx.USD) >= 15)) {
      const e = await pptPrice(c);
      if (e) { market = e.usd * fx.USD; basis = e.basis; }
    }
    // A name+number match without a confirmed set can land on a pricier printing; trust the lower figure.
    if (market != null && c.estUsd && market > 3 * c.estUsd * fx.USD) { market = c.estUsd * fx.USD; basis = 'Claude estimate (catalog match looked wrong)'; }
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
  let bulk = Math.max(0, (ident.totalCardCount || 0) - counted) * m.bulkCadPerCard;
  resale += bulk;
  if (ident.priceScope === 'per_item') {
    // "$40 each": the price buys one unit, so value the best single unit, not the whole pile.
    const units = [...ident.cards, ...(ident.sealed || [])].length ? lines.map(x => x.netCad / Math.max(1, Number((x.label.match(/^(\d+)×/) || [])[1] || 1))) : [];
    resale = Math.max(0, ...units);
    bulk = 0;
  }

  // A $1 "placeholder" price is not the real price; use what the seller actually asks.
  const price = ident.realAskingPriceCad ?? l.priceCad;
  const placeholder = ident.realAskingPriceCad == null && l.priceCad <= 2 && l.source !== 'ebay';
  const tax = l.source === 'ebay' ? (price + (l.shippingCad || 0)) * m.buyerTaxOnline : 0;
  const cost = price + (l.shippingCad || 0) + tax;
  const profit = resale - cost;
  const roi = cost > 0 ? profit / cost : 0;
  const marketTotal = lines.reduce((a, x) => a + x.marketCad, 0);

  let tier = 'pass';
  const { steal, good } = cfg.deal;
    if (ident.fakeRisk !== 'high' && ident.isPokemonCards && !placeholder && ident.priceScope !== 'catalog' && ident.verdict === 'underpriced') {
    if (profit >= steal.minProfitCad && roi >= steal.minRoi) tier = 'steal';
    else if (profit >= good.minProfitCad && roi >= good.minRoi) tier = 'good';
  }
  // Offer: the price at which this would be a steal, rounded down to $5, never above asking.
  const stealPrice = (resale - (l.shippingCad || 0)) / (1 + steal.minRoi);
  const offer = Math.max(5, Math.min(price, Math.floor(stealPrice / 5) * 5));
  return { tier, price, cost, resale, profit, roi, marketTotal, bulk, lines, offer };
}

// Slab alerts only: one look at the photos to confirm the label matches and the slab looks genuine.
const SLAB_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' } }, required: ['ok', 'note'] };
export async function verifySlabPhotos(cfg, l, cardLabel, grade) {
  const { dir, n } = await downloadImages(l, 3);
  try {
    if (!n) return { ok: true, note: 'No photos to check.' };
    return await runClaude(cfg, `eBay listing: ${l.title}\nExpected slab: ${cardLabel}, ${grade}.\nLook at the photos. ok=true only if the slab label shows this card and grade and the slab looks genuine (correct label design, no tampering, not a "proxy"/custom). note: one short sentence for the buyer (e.g. cert number seen, centering, any concern).`, dir, {
      model: cfg.triageModel || 'haiku', schema: SLAB_SCHEMA, maxPx: 1024,
      system: 'You check graded Pokémon card slabs in listing photos for a reseller. Be strict about label mismatches and fakes.',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const passResult = (stage, summary, extra = {}) => ({
  stage, tier: 'pass', price: null, cost: 0, resale: 0, profit: 0, roi: 0, lines: [], bulk: 0, offer: null,
  ident: { kind: 'unknown', fakeRisk: 'low', summary, askSeller: '', hiddenUpside: '' }, ...extra,
});

// Cheapest stage that can decide wins. Returns { stage, tier, ... }.
export async function judge(cfg, l, { allowStage3 = true } = {}) {
  const fx = await getFx();
  const cost0 = l.priceCad + (l.shippingCad || 0) + (l.source === 'ebay' ? (l.priceCad + (l.shippingCad || 0)) * cfg.money.buyerTaxOnline : 0);
  const { good } = cfg.deal;

  // Stage 1: a clear single card priced straight from its title.
  const s1 = await stage1(cfg, l);
  let hint = null;
  if (s1) {
    if (s1.profit < good.minProfitCad / 2 || s1.roi < good.minRoi / 2) return { ...s1, stage: 1, tier: 'pass' };
    hint = `${s1.lines.map(x => `${x.label} ≈ C$${x.marketCad} (${x.basis})`).join('; ')}; title-based profit C$${s1.profit.toFixed(0)}`;
  } else {
    // Stage 2: Haiku glances at the title and one photo.
    const { dir } = await downloadImages(l, 1);
    const img = fs.readdirSync(dir)[0];
    const tdir = img ? dir : null;
    try {
      const t = await runClaude(cfg, TRIAGE(l, cost0, img), tdir, {
        model: cfg.triageModel || 'haiku', schema: TRIAGE_SCHEMA, maxPx: 512,
        system: 'You screen second-hand Pokémon card listings for a reseller. Answer briefly and skeptically.',
      });
      if (!t.worthALook || (t.roughResaleCad != null && t.roughResaleCad < cost0 * 1.3)) {
        return passResult(2, t.reason, { cost: cost0, resale: t.roughResaleCad || 0, profit: (t.roughResaleCad || 0) - cost0 });
      }
      hint = `quick look guessed resale ≈ C$${t.roughResaleCad} (${t.reason})`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Stage 3: Sonnet reads up to 4 photos, following the mint-deal-check checklist.
  if (!allowStage3) throw new Error('rate limit: Sonnet hourly cap reached, retrying later');
  const { dir, n } = await downloadImages(l, 4);
  try {
    const ident = await runClaude(cfg, PROMPT({ ...l, hint }), n ? dir : null, {
      model: cfg.judgeModel, schema: SCHEMA, system: fs.readFileSync(SKILL, 'utf8'), maxPx: 1024,
    });
    const v = await value(cfg, l, ident);
    return { stage: 3, ident, ...v, photos: n };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
