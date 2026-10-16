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
  // A local "free" or C$0 price is usually a placeholder for "ask me": keep those, the judge treats them as price on request.
  if (l.priceCad <= 0 && l.source === 'ebay') return 'free/zero price';
  const auction = l.buyingOptions?.includes('AUCTION') && !l.buyingOptions?.includes('FIXED_PRICE');
  if (!auction && l.priceCad < (cfg.minPriceCad ?? 20)) return `under C$${cfg.minPriceCad ?? 20} ($${l.priceCad})`;
  // Local collections run bigger than single slabs: they get their own ceiling.
  const maxBuy = l.lot ? (cfg.lots?.maxBuyCad ?? cfg.local?.maxBuyCad ?? cfg.maxBuyCad) : l.source === 'ebay' ? cfg.maxBuyCad : (cfg.local?.maxBuyCad ?? cfg.maxBuyCad);
  if (l.priceCad > maxBuy) return `over max buy ($${l.priceCad})`;
  // eBay from outside Canada: only lots survive the 20–35% cross-border costs.
  const slabs = cfg.mode === 'slabs';
  if (l.source === 'ebay' && !slabs && ['JP', 'CN', 'KR', 'HK', 'TW'].includes(l.country)) return 'ships from Asia';
  if (l.source === 'ebay' && l.country !== 'CA' && !auction && !isLot(l.title) && !slabs) return 'foreign eBay single';
  return null;
}

const isLot = t => /\b(lot|bundle|collection|binder|classeur|cartable|bulk|vrac|cartes?\s+pok|\d{2,}\s*(cards|cartes|pcs))\b/i.test(t);
const isSealed = t => /\b(etb|elite trainer|booster box|booster bundle|display|tin|blister|scell[ée]|sealed|neuf)\b/i.test(t);

// ---------- Stage 1: identify a single card from the title, no AI ----------
const NOISE = /\b(\d+(?:st|nd|rd|th)|anniv(?:ersary)?|celebrations?|gem|gem mint|pristine|sv\d+[a-z]?|s\d+[a-z]|swsh\d+|sm\d+[a-z]?|ssr|sar|ar|chr|csr|ur|hr|rr|pok[eé]mon|tcg|promo|japanese|jpn|jp|card|carte|cards|cartes|holo|reverse|rare|ultra|secret|full art|alt art|sir|sar|ir|near mint|nm|lp|mint|english|anglais|fr|en|psa|cgc|bgs|sgc|tag|ace|graded|slab|the|de|du|la|le|\d{4})\b/gi;
export function parseTitle(t) {
  const grade = t.match(/\b(PSA|CGC|BGS|SGC|TAG|ACE)\s*-?\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)(?![\d.\/])/i);
  const num = t.match(/\b(\d{1,3})\s*\/\s*(\d{2,3})\b/) || t.match(/\b(\d{1,3}\s*\/\s*(?:SV|SM|S|XY|BW|DP)-?P)\b/i) || t.match(/\b((?:SV|SWSH|SM|XY|BW)P?\s?-?\d{2,3})\b/i);
  const lang = /japan|japon|\bjp\b|jpn/i.test(t) ? 'jp' : /\bfr\b|fran[cç]ais|french/i.test(t) ? 'fr' : 'en';
  let name = null;
  if (num) {
    const before = t.slice(0, num.index).replace(NOISE, ' ').replace(/[^\p{L}\s'&.-]/gu, ' ').replace(/\s+/g, ' ').trim();
    name = before.split(' ').filter(w => /\p{L}/u.test(w)).slice(-3).join(' ').replace(/^[^\p{L}]+/u, '') || null; // card names sit right before the number
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

export async function downloadImages(l, max = 4) {
  const dir = path.join(DATA, 'img', l.id.replace(/[^a-z0-9]+/gi, '_'));
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const url of l.images.slice(0, max)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': UA } });
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

export function runClaude(cfg, prompt, imgDir, { model, schema, system, maxPx = 1024 }) {
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
  let backed = 0; // resale value priced from real data (catalog/sold prices), not Claude's own estimate
  for (const c of ident.cards) {
    const qty = Math.max(1, c.quantity || 1);
    counted += qty;
    let market = null, basis = '';
    if (!c.grade) {
      const p = await priceCard(c, { strict });
      if (p) { market = p.cad; basis = p.basis + (p.ambiguous ? ' (cheapest match)' : ''); }
    }
    // Real eBay sold prices for slabs, and for raw cards worth enough to matter (free plan ≈ 40 lookups/day).
    if (pptOk && (c.grade || (market ?? (c.estUsd || 0) * fx.USD) >= (cfg.pptMinCad ?? 3))) {
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
    if (!/Claude estimate/.test(basis)) backed += Math.max(0, net);
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
  return { tier, price, cost, resale, profit, roi, marketTotal, bulk, lines, offer, placeholder, backedShare: resale > 0 ? backed / resale : 0 };
}

// Slab alerts only: one look at the photos to confirm the label matches and the slab looks genuine.
const SLAB_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' }, cert: { type: ['string', 'null'] }, cardName: { type: ['string', 'null'] } }, required: ['ok', 'note', 'cert', 'cardName'] };
export async function verifySlabPhotos(cfg, l, cardLabel, grade) {
  const { dir, n } = await downloadImages(l, 3);
  try {
    if (!n) return { ok: true, note: 'No photos to check.' };
    // Only alert candidates get here, so it's worth the stronger model: Haiku misread a TAG label as
    // another grader and called the real "Mega Attack Rare" rarity a proxy.
    return await runClaude(cfg, `eBay listing: ${l.title}\nExpected slab: ${cardLabel}, ${grade}.\nLook at the photos. ok=true only if the slab label shows this card and grade and the slab looks genuine (correct label design for that grader, no tampering, not a "proxy"/custom). Newer sets use rarity names you may not know (e.g. "Mega Attack Rare", "Futuristic Rare"); an unfamiliar rarity alone is not a red flag. note: one short sentence for the buyer (centering, any concern). cert: the certification number printed on the label (digits only), or null if you can't read it. cardName: the card's name as printed on the label, in English (e.g. "Squawkabilly ex"), or null. If the expected card name above isn't a real Pokémon card name, judge the label alone.`, dir, {
      model: cfg.judgeModel || 'sonnet', schema: SLAB_SCHEMA, maxPx: 1024,
      system: 'You check graded Pokémon card slabs in listing photos for a reseller. Be strict about label mismatches and fakes.',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// When a slab's title doesn't say which card it is, read the label from the photos (Haiku, ~2 photos).
const SLAB_ID_SCHEMA = {
  type: 'object',
  properties: {
    isSingleSlab: { type: 'boolean' }, name: { type: ['string', 'null'] }, number: { type: ['string', 'null'] },
    setName: { type: ['string', 'null'] }, grader: { type: ['string', 'null'] }, grade: { type: ['string', 'null'] },
    language: { type: 'string', enum: ['en', 'jp', 'other', 'unknown'] },
  },
  required: ['isSingleSlab', 'name', 'number', 'setName', 'grader', 'grade', 'language'],
};
export async function identifySlabAI(cfg, l) {
  const { dir, n } = await downloadImages(l, 2);
  try {
    return await runClaude(cfg, `eBay listing: ${l.title}\n${(l.description || '').slice(0, 400)}\nRead the slab label in the photos. Give the card's English name (e.g. "Charizard ex"), its collector number as printed (e.g. "199/165" or "SVP 173"), set name, grader (PSA/CGC/BGS/TAG/SGC/ACE) and grade number (e.g. "10", "9.5"). isSingleSlab=false for lots, raw cards or sealed product. Use null for anything you can't read.`, n ? dir : null, {
      model: cfg.triageModel || 'haiku', schema: SLAB_ID_SCHEMA, maxPx: 1024,
      system: 'You read graded trading card labels from listing photos. Be exact; never guess a number you cannot see.',
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
export async function judge(cfg, l, { allowStage3 = true, detail = null } = {}) {
  const fx = await getFx();
  const cost0 = l.priceCad + (l.shippingCad || 0) + (l.source === 'ebay' ? (l.priceCad + (l.shippingCad || 0)) * cfg.money.buyerTaxOnline : 0);
  const { good } = cfg.deal;

  // Marketplace/Kijiji deals are rare and hide in photos and descriptions, so they skip the
  // title-only shortcuts and always get the full Sonnet read. eBay keeps the cheap stages.
  const deep = l.source !== 'ebay' && cfg.deepLocal !== false;
  const s1 = deep || l.lot ? null : await stage1(cfg, l);
  let hint = null;
  if (deep) {
    hint = 'local listing: read the description and every photo carefully; look for valuable cards hidden in lots and binders';
  } else if (s1) {
    if (s1.profit < good.minProfitCad / 2 || s1.roi < good.minRoi / 2) return { ...s1, stage: 1, tier: 'pass' };
    hint = `${s1.lines.map(x => `${x.label} ≈ C$${x.marketCad} (${x.basis})`).join('; ')}; title-based profit C$${s1.profit.toFixed(0)}`;
  } else {
    // Stage 2: Haiku glances at the title and one photo. Some eBay lots come back from search without one.
    if (l.lot && !l.images?.length && detail) l = { ...(await detail(l)), hint: l.hint };
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
  // Full listing page (description + every photo) only now, for the few that reach Stage 3.
  if (detail) l = { ...(await detail(l)), hint: l.hint };
  const { dir, n } = await downloadImages(l, deep || l.lot ? 12 : 4);
  try {
    let ident = await runClaude(cfg, PROMPT({ ...l, hint }), n ? dir : null, {
      model: cfg.judgeModel, schema: SCHEMA, system: fs.readFileSync(SKILL, 'utf8'), maxPx: n > 6 ? 900 : 1024,
    });
    let v = await value(cfg, l, ident);
    // Promising or vintage collections get the photo-by-photo read before deciding: one call over many
    // reduced photos misses about half the cards.
    // Every local collection gets the photo-by-photo read (lots are the core business); singles don't need it.
    // eBay lots arrive by the dozen an hour, so only the promising ones (resale at least half the cost) get it there.
    if (n >= 2 && (deep || (l.lot && v.resale >= 0.5 * v.cost)) && (['lot', 'mixed'].includes(ident.kind) || (ident.totalCardCount || 0) > 15)) {
      const d = await readPhotosDeep(cfg, l, dir);
      ident = withDeep(ident, d);
      v = await value(cfg, l, ident);
      log(`deep read ${l.id}: ${d.photosRead} photos, ${d.cards.length} cards → resale C$${v.resale.toFixed(0)}`);
    }
    if (deep || l.lot) v = await localDecision(cfg, l, ident, v);
    const shown = v.rejected ? { ...ident, summary: `${ident.summary} Not alerted: ${v.rejected}.` } : v.secondCheck ? { ...ident, summary: `${ident.summary} Second check: ${v.secondCheck}` } : ident;
    return { stage: 3, ...v, ident: shown, photos: n };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Local (Marketplace/Kijiji) alerts: offers, evidence, and a skeptical second check ----------
// Collections are negotiated: "worth C$500, asking C$250, offer C$180" is a deal even though the asking price
// isn't. But every local alert must rest mostly on real price data (not Claude's own guesses) and survive a
// second reviewer, the same bar as eBay slabs.
const LOCAL_SECOND = {
  type: 'object',
  properties: { confirm: { type: 'boolean' }, fairResaleCad: { type: 'number' }, reason: { type: 'string' } },
  required: ['confirm', 'fairResaleCad', 'reason'],
};
async function localDecision(cfg, l, ident, v) {
  const { steal, good } = cfg.deal;
  const lc = cfg.local || {};
  const usable = ident.isPokemonCards && ident.fakeRisk !== 'high' && !v.placeholder && ident.priceScope !== 'catalog';
  let out = { ...v, action: 'buy' };
  // eBay lot auctions (judged in their last hour): the alert is a maximum bid, not a buy.
  const ebay = l.source === 'ebay';
  const auction = ebay && l.buyingOptions?.includes('AUCTION') && !l.buyingOptions?.includes('FIXED_PRICE');
  if (auction) {
    const tax = 1 + cfg.money.buyerTaxOnline;
    const maxBid = Math.floor(((v.resale / (1 + good.minRoi)) / tax - (l.shippingCad || 0)) / 5) * 5;
    if (usable && (l.bids ?? 0) <= (cfg.lots?.maxBids ?? 3) && maxBid >= l.priceCad * 1.2) {
      const payAll = (maxBid + (l.shippingCad || 0)) * tax;
      out = { ...out, tier: v.resale - payAll >= steal.minProfitCad && (v.resale - payAll) / payAll >= steal.minRoi ? 'steal' : 'good', action: 'auction', offer: maxBid, cost: payAll, profit: v.resale - payAll, roi: (v.resale - payAll) / payAll };
    } else return { ...out, tier: 'pass' };
  }
  // Not a deal at the asking price, but a realistic offer makes it one (on eBay only when the seller takes offers).
  const offerProfit = v.resale - v.offer;
  if (!auction && (!ebay || l.buyingOptions?.includes('BEST_OFFER')) && usable && v.tier === 'pass' && ['underpriced', 'fair'].includes(ident.verdict) && ident.priceScope === 'whole_listing'
    && v.offer < v.price && v.offer >= v.price * (lc.minOfferRatio ?? 0.65)
    && offerProfit >= good.minProfitCad && offerProfit / v.offer >= good.minRoi) {
    out = { ...out, tier: offerProfit >= steal.minProfitCad && offerProfit / v.offer >= steal.minRoi ? 'steal' : 'good', action: 'offer' };
  }
  // "C$1" placeholder on a valuable collection = price on request. Not a buy yet, but a lead worth one message.
  if (!ebay && out.tier === 'pass' && v.placeholder && ident.isPokemonCards && ident.fakeRisk === 'low' && ident.priceScope !== 'catalog'
    && ['lot', 'mixed', 'graded'].includes(ident.kind) && v.resale >= (lc.minAskResale ?? 150) && v.backedShare >= (lc.minBackedShare ?? 0.6)) {
    const fr = /\b(cartes?|classeur|collection|vends|à vendre|les|des|et|avec)\b/i.test(`${l.title} ${l.description || ''}`);
    const pay = Math.floor(v.resale / (1 + good.minRoi) / 5) * 5;
    return { ...out, tier: 'good', action: 'ask', offer: pay, price: 0, cost: 0, profit: v.resale - pay, roi: pay > 0 ? (v.resale - pay) / pay : 0,
      draft: fr ? 'Bonjour! Les cartes sont toujours disponibles? Quel serait votre prix pour tout le lot? Je peux passer rapidement et payer comptant.' : 'Hi! Are the cards still available? What would you take for the whole lot? I can pick up quickly and pay cash.' };
  }
  if (out.tier === 'pass') return out;
  const reject = why => ({ ...out, tier: 'pass', rejected: why });
  if (v.backedShare < (lc.minBackedShare ?? 0.6)) return reject(`value rests mostly on AI estimates (${Math.round(v.backedShare * 100)}% from real price data)`);
  const pay = out.action === 'offer' ? v.offer : out.action === 'auction' ? out.cost : v.cost;
  const prompt = [
    `Local ${l.source} listing near Montréal: "${l.title}"`,
    `Asking: C$${v.price}. ${out.action === 'offer' ? `Plan: offer C$${v.offer} cash.` : 'Plan: buy at asking.'}`,
    `Description: ${(l.description || '').slice(0, 1200)}`,
    `What the photo reader found (${ident.totalCardCount ?? '?'} cards total, language ${ident.language}, fake risk ${ident.fakeRisk}): ${ident.summary}`,
    `Priced lines (market C$ → net after eBay fees and shipping):\n${v.lines.map(x => `- ${x.label}: C$${x.marketCad} → C$${x.netCad} (${x.basis})`).join('\n')}`,
    `Bulk allowance C$${v.bulk.toFixed(0)}. Total resale C$${v.resale.toFixed(0)}, profit C$${(v.resale - pay).toFixed(0)} at C$${pay}.`,
    '',
    'Find any reason this is NOT a real flip: cards misidentified (wrong set/printing, reprints like Evolutions/Celebrations/30th, Japanese or French valued as English), condition likely worse, values from the wrong card, duplicates double-counted, a per-card or "market value" price mistaken for a lot price, fakes, or a seller who clearly knows the value.',
    'fairResaleCad: what you are confident the whole lot nets after eBay fees within ~1 month, low end of the evidence.',
    `confirm=true only if, paying C$${pay}, profit is at least C$${good.minProfitCad} and ${Math.round(good.minRoi * 100)}% of cost. reason: one short sentence.`,
  ].join('\n');
  const r = await runClaude(cfg, prompt, null, { model: cfg.judgeModel, schema: LOCAL_SECOND, system: 'You are a skeptical reviewer for a Pokémon card flipper buying local collections. False alarms waste his time; when in doubt, reject.' })
    .catch(e => ({ confirm: false, reason: `second check unavailable (${e.message})`, fairResaleCad: 0 }));
  const p2 = r.fairResaleCad - pay;
  if (!r.confirm || p2 < good.minProfitCad || p2 / pay < good.minRoi) return reject(`second check rejected: ${r.reason}`);
  return { ...out, resale: Math.min(v.resale, r.fairResaleCad), profit: Math.min(v.resale, r.fairResaleCad) - pay, roi: (Math.min(v.resale, r.fairResaleCad) - pay) / pay, secondCheck: r.reason };
}

// ---------- Quotes: Ryan photographs a collection in person (show, seller's home, DMs) ----------
export async function quoteLot(cfg, { id, note, asking }, dir) {
  const l = { source: 'quote', id: `quote:${id}`, title: note || 'Collection photographed for a buy quote', description: note || '', priceCad: asking ?? 0, location: 'Montréal', images: [] };
  const hint = 'Ryan photographed this collection in person to decide what to pay. List EVERY card worth roughly US$2+ across all photos (binder pages, piles, slabs), with set and number when readable. Estimate totalCardCount from the photos and the note.';
  // Overview (what it is, language, fakes) and a photo-by-photo read of every card, in parallel.
  const [overview, deep] = await Promise.all([
    runClaude(cfg, PROMPT({ ...l, hint }), dir, { model: cfg.judgeModel, schema: SCHEMA, system: fs.readFileSync(SKILL, 'utf8'), maxPx: 1100 }),
    readPhotosDeep(cfg, l, dir),
  ]);
  const ident = withDeep(overview, deep);
  const v = await value(cfg, l, ident);
  const { steal, good } = cfg.deal;
  const floor5 = x => Math.max(0, Math.floor(x / 5) * 5);
  return {
    summary: ident.summary, totalCards: ident.totalCardCount ?? null, photosRead: deep.photosRead, resale: +v.resale.toFixed(2), marketTotal: +v.marketTotal.toFixed(2),
    offerSteal: floor5(v.resale / (1 + steal.minRoi)), offerGood: floor5(Math.min(v.resale / (1 + good.minRoi), v.resale - good.minProfitCad)),
    profitAtAsking: asking != null ? +(v.resale - asking).toFixed(2) : null, lines: v.lines, askSeller: ident.askSeller || '', fakeRisk: ident.fakeRisk,
  };
}

// ---------- Deep read: one photo at a time, full resolution ----------
// Reading 10 binder photos in one call at reduced size misses most cards. Each photo alone at ~1600px
// lets the model read names and numbers on every visible card; results are merged and priced as usual.
const PHOTO_CARDS = {
  type: 'object',
  properties: {
    cardsVisible: { type: 'integer' },
    cards: SCHEMA.properties.cards,
    sealed: SCHEMA.properties.sealed,
  },
  required: ['cardsVisible', 'cards', 'sealed'],
};
const PHOTO_PROMPT = (l, i, n) => `Photo ${i} of ${n} from a Pokémon card collection being valued for purchase ("${l.title}").
${l.description ? `Seller's text: ${l.description.slice(0, 800)}\n` : ''}Look at this one photo closely. cardsVisible: how many cards you can see in it (count binder slots and piles).
cards: EVERY card in this photo worth roughly US$2 or more: holos, reverse holos of good cards, ex/EX/GX/V/VMAX/VSTAR, full arts, illustration rares, trainer gallery, vintage WOTC rares, 1st Edition, shadowless, promos, slabs. English name (translate French/Japanese), collector number and set total if readable, set name, variant (1st/holo/reverse/normal), condition you can see (NM/LP/MP/HP/DMG, "unknown" if not visible), estUsd = raw near-mint TCGplayer market USD (or the slab's graded price, with grade). Never guess an expensive card you can't actually read; skip commons, uncommons and energies.
sealed: any sealed product in this photo.`;

export async function readPhotosDeep(cfg, l, dir) {
  const files = fs.readdirSync(dir).filter(f => /^\d+\.(jpg|jpeg|png|webp)$/i.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  const out = [];
  // Three photos at a time: each is an independent read.
  for (let i = 0; i < files.length; i += 3) {
    out.push(...await Promise.all(files.slice(i, i + 3).map(async (f, k) => {
      const one = path.join(dir, `one_${i + k}`);
      fs.mkdirSync(one, { recursive: true });
      fs.copyFileSync(path.join(dir, f), path.join(one, f));
      try {
        return await runClaude(cfg, PHOTO_PROMPT(l, i + k + 1, files.length), one, { model: cfg.judgeModel, schema: PHOTO_CARDS, system: 'You identify Pokémon cards in photos for a reseller. Be exact; skip what you cannot read.', maxPx: 1600 });
      } catch (e) { log('deep read failed', l.id, f, e.message); return null; }
      finally { fs.rmSync(one, { recursive: true, force: true }); }
    })));
  }
  // The same card can appear in two photos (overview + close-up): keep the larger count per card, don't add.
  const key = c => `${String(c.name).toLowerCase().replace(/[^a-z0-9]/g, '')}|${String(c.number || '').split('/')[0].replace(/^0+/, '')}|${c.grade || ''}`;
  const cards = new Map();
  for (const r of out.filter(Boolean)) {
    const perPhoto = new Map();
    for (const c of r.cards) perPhoto.set(key(c), { ...c, quantity: (perPhoto.get(key(c))?.quantity || 0) + Math.max(1, c.quantity || 1) });
    for (const [k, c] of perPhoto) if (!cards.has(k) || cards.get(k).quantity < c.quantity) cards.set(k, c);
  }
  const sealed = out.filter(Boolean).flatMap(r => r.sealed || []);
  return { cards: [...cards.values()], sealed, cardsVisible: out.filter(Boolean).reduce((a, r) => a + (r.cardsVisible || 0), 0), photosRead: out.filter(Boolean).length };
}
export { PROMPT as PROMPT_FOR_TEST, SCHEMA as SCHEMA_FOR_TEST };

// Photo-by-photo cards replace the overview's list (they're read at full resolution); the overview keeps
// the judgement calls: what the listing is, language, fakes, price scope.
function withDeep(overview, d) {
  if (!d?.photosRead) return overview;
  return { ...overview, cards: d.cards.length ? d.cards : overview.cards, sealed: d.sealed.length ? d.sealed : overview.sealed, totalCardCount: Math.max(overview.totalCardCount || 0, d.cardsVisible) || null };
}
