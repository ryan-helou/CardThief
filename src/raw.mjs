import fs from 'node:fs';
import { log } from './util.mjs';
import { getFx } from './price.mjs';
import { pptPrice, pptSales, pptAvailable, pptPaced } from './ppt.mjs';
import { parseTitle, runClaude, downloadImages } from './judge.mjs';
import { identify } from './slabs.mjs';
import { ebayDetail } from './sources/ebay.mjs';

// Raw (ungraded) eBay singles, run in shadow mode first: alerts go to data/raw-shadow.jsonl for review,
// never to the phone, until the hit rate matches slabs. Raw is harder to trust than a slab: condition is
// a judgement call, sold prices mix every condition, and fakes have no slab to vouch for them. So every
// card is valued as played (not near mint), and only cards worth C$50+ near mint are considered.

const pass = (why, extra = {}) => ({ stage: 1, tier: 'pass', price: null, cost: 0, resale: 0, profit: 0, roi: 0, lines: [], bulk: 0, offer: null, ident: { kind: 'single', fakeRisk: 'low', summary: why, askSeller: '', hiddenUpside: '' }, ...extra });
const isLot = t => /\b(lot|bundle|collection|binder|bulk|set of|\d+\s*(cards|pcs|pieces)|x\s?\d+|\d+\s?x)\b/i.test(t);
const NOT_A_CARD = /\b(proxy|custom|orica|fan ?art|replica|reprint|metal card|gold card|digital|code card|sticker|sleeve|playmat|toploader|jumbo|oversized|sealed|booster|etb|tin)\b/i;
// Of near-mint value, what a card in each condition resells for.
const CONDITION = { NM: 1, LP: 0.8, MP: 0.6, HP: 0.4, DMG: 0.25 };

export async function judgeRaw(cfg, l) {
  const r = cfg.raw || {};
  const m = cfg.money;
  const fx = await getFx();
  if (isLot(l.title)) return pass('lot (raw mode is singles only)');
  if (NOT_A_CARD.test(l.title)) return pass('not a genuine single card');
  if (/japan|japon|\bjp\b|jpn|korean|chinese|german|deutsch|french|fran[cç]ais|italian|italiano|spanish|espa[nñ]ol|portuguese/i.test(l.title)) return pass('non-English raw card (not tracked yet)');
  if (/\b(PSA|CGC|BGS|SGC|TAG|ACE)\s*\d/i.test(l.title)) return pass('graded (handled by the slab judge)');

  // Free first: name + number from the title, near-mint price from the TCGdex catalog.
  let id = await identify(l.title);
  let nm = id?.raw?.cad || 0;
  // The free catalog lags new sets (30th Celebration) and sometimes lands on a cheap printing: when the
  // title gives a clear "name 153/128", ask the sold-price database too, budget permitting (slabs come first).
  const p = parseTitle(l.title);
  if ((!id || nm < (r.minNmCad ?? 50)) && p.name && p.setTotal && pptAvailable() && pptPaced()) {
    const alt = await pptPrice({ name: p.name, number: p.number, grade: null, title: l.title }).catch(() => null);
    if (alt?.usd && alt.usd * fx.USD > nm) { nm = alt.usd * fx.USD; id = { card: { name: p.name, number: p.number, setTotal: p.setTotal, variant: p.variant }, raw: { cad: nm, basis: alt.basis } }; }
  }
  if (!id?.raw?.cad) return pass("couldn't identify the card from the title");
  const card = { ...id.card, title: l.title };
  if (nm < (r.minNmCad ?? 50)) return pass(`worth ~C$${nm.toFixed(0)} near mint, under the C$${r.minNmCad ?? 50} raw minimum`);
  const cost = (l.priceCad + (l.shippingCad || 0)) * (1 + m.buyerTaxOnline);
  const ship = r.resaleShipCad ?? 6;
  const net = v => v * (1 - m.ebaySellFee) - m.ebayOrderFee - ship;
  // Played value (LP): a hidden flaw must not kill the profit.
  if (net(nm * CONDITION.LP) - cost < cfg.deal.good.minProfitCad) return pass(`C$${cost.toFixed(0)} all-in vs ~C$${(nm * CONDITION.LP).toFixed(0)} played (C$${nm.toFixed(0)} near mint, ${id.raw.basis})`, { cost });

  // Candidate: proven raw sales. Value = lower of the 30-day ungraded sale median and the played catalog price.
  if (!pptAvailable()) return pass('sold-price budget used up for now', { cost });
  const sold = await pptPrice({ ...card, grade: null });
  const hist = await pptSales({ ...card, grade: null }).catch(() => null);
  const n = hist?.sales.length ?? 0;
  if (n < (r.minSales30 ?? 5)) return pass(`only ${n} raw sales in the last 30 days: too few to trust a value`, { cost, stage: 1 });
  const med30 = hist.median * fx.USD;
  let value = Math.min(med30, nm * CONDITION.LP, sold?.usd ? sold.usd * fx.USD : Infinity);

  // Photos: condition, authenticity, right card and printing (Sonnet; only candidates get here).
  l = await ebayDetail(cfg, l, fx);
  if ((l.images || []).length < (r.minPhotos ?? 2)) return pass('fewer than 2 photos: condition can\'t be checked', { cost, stage: 1 });
  const v = await checkRawPhotos(cfg, l, `${card.name} ${card.number}`).catch(e => ({ ok: false, note: `photo check unavailable (${e.message})` }));
  if (!v.ok) return pass(`photo check failed: ${v.note}`, { cost, stage: 3 });
  value = Math.min(value, nm * (CONDITION[v.condition] ?? CONDITION.MP));

  const resale = net(value);
  const profit = resale - cost, roi = profit / cost;
  const { steal, good } = cfg.deal;
  const tier = profit >= steal.minProfitCad && roi >= steal.minRoi ? 'steal' : profit >= good.minProfitCad && roi >= good.minRoi ? 'good' : 'pass';
  const basis = `lower of 30-day median of ${n} raw sales (C$${med30.toFixed(0)}), ${v.condition} catalog value (C$${(nm * (CONDITION[v.condition] ?? 0.6)).toFixed(0)})`;
  if (tier === 'pass') return pass(`raw ${v.condition} at C$${cost.toFixed(0)} all-in vs ~C$${value.toFixed(0)} (${basis})`, { cost, stage: 3 });

  const r2 = await secondOpinionRaw(cfg, { l, card, cost, value, resale, profit, condition: v.condition, hist, nm, basis })
    .catch(e => ({ confirm: false, reason: `second check unavailable (${e.message})` }));
  if (!r2.confirm) return pass(`second check rejected: ${r2.reason}`, { cost, stage: 3 });
  log(`raw ${l.id}: ${v.condition} cost C$${cost.toFixed(0)} value C$${value.toFixed(0)} → ${tier}`);
  return {
    stage: 3, tier, action: 'buy', price: l.priceCad, cost, resale, profit, roi, bulk: 0, offer: null,
    lines: [{ label: `${card.name} ${card.number} (raw, ${v.condition})`, marketCad: +value.toFixed(2), netCad: +resale.toFixed(2), basis }],
    ident: { kind: 'single', fakeRisk: v.fakeRisk || 'low', summary: `Raw ${card.name} ${card.number}, looks ${v.condition}, at C$${cost.toFixed(0)} all-in vs ~C$${value.toFixed(0)} (${basis}). ${v.note} Second check: ${r2.reason}`, askSeller: '', hiddenUpside: '' },
  };
}

const RAW_PHOTO_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' }, condition: { type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG'] },
    fakeRisk: { type: 'string', enum: ['low', 'medium', 'high'] }, note: { type: 'string' },
  },
  required: ['ok', 'condition', 'fakeRisk', 'note'],
};
async function checkRawPhotos(cfg, l, cardLabel) {
  const { dir, n } = await downloadImages(l, 4);
  try {
    if (n < 2) return { ok: false, condition: 'MP', note: 'not enough photos to judge condition' };
    return await runClaude(cfg, `eBay listing: ${l.title}\nCondition stated: ${l.condition || 'n/a'}\nDescription: ${(l.description || '').slice(0, 500)}\nExpected card: ${cardLabel}.\nLook at every photo. ok=true only if this is a genuine single Pokémon card matching the expected card and printing (watch for 1st Edition vs unlimited, reverse holo vs holo, reprints), front and back are both shown, and nothing looks fake (wrong font, colors, texture, missing holo pattern). condition: grade it strictly from what you can see (NM, LP, MP, HP, DMG); if the photos are too small or blurry to see corners and edges, say MP. note: one short sentence (condition details or the concern).`, dir, {
      model: cfg.judgeModel || 'sonnet', schema: RAW_PHOTO_SCHEMA, maxPx: 1280,
      system: 'You grade raw Pokémon cards from listing photos for a reseller. Be strict: overestimating condition loses money.',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SECOND_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean' }, fairResaleCad: { type: 'number' }, reason: { type: 'string' } },
  required: ['confirm', 'fairResaleCad', 'reason'],
};
async function secondOpinionRaw(cfg, { l, card, cost, value, resale, profit, condition, hist, nm, basis }) {
  const m = cfg.money, good = cfg.deal.good, ship = cfg.raw?.resaleShipCad ?? 6;
  const prompt = [
    `eBay listing (raw, ungraded card): "${l.title}"`,
    `Seller: ${l.seller || 'unknown'} · stated condition: ${l.condition || 'n/a'}`,
    `Description: ${(l.description || '').slice(0, 600)}`,
    `Identified as: ${card.name} ${card.number}; photo check graded it ${condition}. Near-mint catalog price C$${nm.toFixed(0)}.`,
    `All-in cost C$${cost.toFixed(0)}. Value used C$${value.toFixed(0)} (${basis}); after fees and C$${ship} shipping, resale nets C$${resale.toFixed(0)}, profit C$${profit.toFixed(0)}.`,
    `Raw (ungraded) eBay sales of this card, last 30 days (USD, daily average x count): ${hist?.days.join('; ') || 'none'}`,
    '',
    'Find any reason this is NOT a real flip: wrong card or printing (1st Edition vs unlimited, reverse vs holo, a reprint like Evolutions or Celebrations), raw sales polluted by graded or sealed sales or by a pricier printing, condition likely worse than graded, a falling price, red flags in the title or description.',
    'fairResaleCad: the price (C$, before fees) you are confident this raw card in this condition sells for within ~2 weeks, using the low end of the evidence.',
    `confirm=true only if, at that price, profit after fees is at least C$${good.minProfitCad} and ${Math.round(good.minRoi * 100)}% of cost, and nothing looks wrong. reason: one short sentence.`,
  ].join('\n');
  const r = await runClaude(cfg, prompt, null, { model: cfg.judgeModel || 'sonnet', schema: SECOND_SCHEMA, system: 'You are a skeptical reviewer for a Pokémon card reseller. False alarms cost real money; when in doubt, reject.' });
  const n2 = r.fairResaleCad * (1 - m.ebaySellFee) - m.ebayOrderFee - ship;
  if (r.confirm && (n2 - cost < good.minProfitCad || (n2 - cost) / cost < good.minRoi)) return { confirm: false, reason: `at a fair C$${Math.round(r.fairResaleCad)} the profit is only C$${Math.round(n2 - cost)}` };
  return r;
}
