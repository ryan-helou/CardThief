import fs from 'node:fs';
import path from 'node:path';
import { DATA, log } from './util.mjs';
import { priceCard, getFx } from './price.mjs';
import { pptPrice, pptAvailable } from './ppt.mjs';
import { parseTitle, verifySlabPhotos } from './judge.mjs';

// Slabs-only eBay mode. A graded card's condition is on the label and its value is the eBay
// sold median for that exact grade, so most slabs are judged with no AI at all.
const GRADERS = { 'Professional Sports Authenticator (PSA)': 'PSA', 'Certified Guaranty Company (CGC)': 'CGC', 'Beckett Collectors Club Grading (BCCG)': 'BCCG', 'Beckett Grading Services (BGS)': 'BGS', 'Sportscard Guaranty (SGC)': 'SGC', 'Technical Authentication & Grading (TAG)': 'TAG', 'Ace Grading': 'ACE' };

// Grade from the title, else from the seller's eBay item specifics ("Professional Grader" / "Grade").
export function slabGrade(l) {
  const t = parseTitle(l.title).grade;
  if (t) return t;
  const c = l.condition || '';
  const grader = Object.entries(GRADERS).find(([k]) => c.includes(k))?.[1] || c.match(/\b(PSA|CGC|BGS|SGC|TAG|ACE)\b/)?.[1];
  const grade = c.match(/Grade:\s*([\d.]+)/)?.[1];
  return grader && grade ? `${grader} ${grade}` : null;
}

// Disk cache: one eBay-sold lookup covers every grade of a card for a day, saving PokemonPriceTracker credits.
const cacheFile = path.join(DATA, 'slab-price-cache.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
async function gradePrice(card) {
  const key = `${card.name}|${card.number}|${card.grade}`.toLowerCase();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.p;
  const p = await pptPrice(card);
  cache[key] = { at: Date.now(), p };
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return p;
}

// Slab titles come in two shapes: "Charizard ex 199/165 PSA 10" and the PSA-label style
// "2023 POKEMON MEW EN-151 #199 CHARIZARD EX PSA 10". Find the number, then try each word
// (and word pair) as the card name against the free TCGdex catalog.
const STOP = /^(pokemon|pokémon|tcg|card|cards|holo|rare|illustration|special|ultra|secret|full|art|promo|black|star|mint|gem|graded|the|of|and|en|jp|edition|1st|shiny|reverse|psa|cgc|bgs|sgc|tag|ace|collection|ex?)$/i;
async function identify(title) {
  const p = parseTitle(title);
  const hash = title.match(/#\s?(\d{1,3})\b/);
  const number = p.number || (hash ? hash[1] : null);
  if (!number) return null;
  const words = title.replace(/[^\p{L}\d'\s-]/gu, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.test(w) && !/^\d+$/.test(w) && !/^[A-Z]{2,4}-?$/.test(w));
  const after = hash ? title.slice(hash.index + hash[0].length).split(/\b(PSA|CGC|BGS|SGC|TAG|ACE)\b/i)[0].trim() : '';
  const tries = [...new Set([after, p.name, ...words.flatMap((w, i) => [words.slice(i, i + 2).join(' '), w])].filter(Boolean))];
  for (const name of tries.slice(0, 14)) {
    const card = { name: name.replace(/\s+ex$/i, ' ex'), number, setTotal: p.setTotal, variant: p.variant };
    const raw = await priceCard(card, { strict: Boolean(p.setTotal) });
    if (raw) return { card: { ...card, name: raw.name || card.name }, raw };
  }
  return null;
}

const pass = (why, extra = {}) => ({ stage: 1, tier: 'pass', price: null, cost: 0, resale: 0, profit: 0, roi: 0, lines: [], bulk: 0, offer: null, ident: { kind: 'graded', fakeRisk: 'low', summary: why, askSeller: '', hiddenUpside: '' }, ...extra });

export async function judgeSlab(cfg, l) {
  const s = cfg.slabs;
  const m = cfg.money;
  const fx = await getFx();
  if (/japan|japon|\bjp\b|jpn|korean|chinese|s-chinese|t-chinese/i.test(l.title)) return pass('non-English slab (no sold data yet)');
  const grade = slabGrade(l);
  if (!grade) return pass('no grade found');
  const [grader, num] = grade.split(' ');
  if (!s.graders.includes(grader)) return pass(`grader ${grader} not tracked`);
  if (Number(num) < s.minGrade) return pass(`${grade} below minimum grade`);
  const id = await identify(l.title);
  if (!id) return pass(`couldn't identify the card from "${l.title}"`);

  const tax = (l.priceCad + (l.shippingCad || 0)) * m.buyerTaxOnline;
  const cost = l.priceCad + (l.shippingCad || 0) + tax;
  const card = { ...id.card, grade };
  const raw = id.raw;
  // Free pre-screen: a slab can't be a steal if it already costs more than a generous multiple of the raw card.
  if (raw) {
    const ceiling = raw.cad * (Number(num) >= 10 || grade === 'BGS 9.5' ? s.maxGemMultiple : s.maxNineMultiple);
    if (cost > ceiling) return pass(`priced above ${grade} ceiling (raw C$${raw.cad.toFixed(0)})`, { cost });
  }
  if (!pptAvailable()) return pass('out of eBay sold-price lookups for today', { cost, retry: true });
  const sold = await gradePrice({ ...card, grade });
  if (!sold) return pass(`no eBay sold data for ${card.name} ${card.number} ${grade}`, { cost });
  const daysSince = sold.lastSale ? (Date.now() - new Date(sold.lastSale)) / 864e5 : 999;
  if ((sold.sales ?? 0) < s.minSales || daysSince > s.maxDaysSinceSale) return pass(`illiquid: ${sold.sales} sales, last ${Math.round(daysSince)} days ago`, { cost });

  const market = sold.usd * fx.USD;
  const resale = market * (1 - m.ebaySellFee) - m.ebayOrderFee - s.resaleShipCad;
  const profit = resale - cost;
  const roi = profit / cost;
  const { steal, good } = cfg.deal;
  // Most you can pay all-in and still make a "good" deal, turned back into an item price.
  const maxAllIn = Math.min(resale / (1 + good.minRoi), resale - good.minProfitCad);
  const maxItem = Math.floor(((maxAllIn / (1 + m.buyerTaxOnline)) - (l.shippingCad || 0)) / 5) * 5;

  let summaryNote = '';
  let tier = profit >= steal.minProfitCad && roi >= steal.minRoi ? 'steal' : profit >= good.minProfitCad && roi >= good.minRoi ? 'good' : 'pass';
  let action = 'buy';
  const isAuction = l.buyingOptions?.includes('AUCTION') && !l.buyingOptions?.includes('FIXED_PRICE');
  if (isAuction) {
    action = 'auction';
    if (tier === 'pass' && maxItem > l.priceCad * 1.1 && (l.bids ?? 0) <= s.maxBids) tier = 'good';
  } else if (tier === 'pass' && l.buyingOptions?.includes('BEST_OFFER') && maxItem >= l.priceCad * s.minOfferRatio) {
    action = 'offer';
    tier = 'good';
  }
  // For offers and auctions, show the numbers at the suggested price, not the current one.
  let showCost = cost, showProfit = profit, showRoi = roi;
  if (action !== 'buy' && tier !== 'pass') {
    showCost = (maxItem + (l.shippingCad || 0)) * (1 + m.buyerTaxOnline);
    showProfit = resale - showCost;
    showRoi = showProfit / showCost;
  }
  if (tier !== 'pass') {
    const v = await verifySlabPhotos(cfg, l, `${card.name} ${card.number}`, grade).catch(e => ({ ok: true, note: `photo check skipped: ${e.message}` }));
    if (!v.ok) return pass(`photo check failed: ${v.note}`, { cost, stage: 3 });
    summaryNote = v.note;
  }
  const line = { label: `${card.name} ${card.number} ${grade}`, marketCad: +market.toFixed(2), netCad: +resale.toFixed(2), basis: `${sold.basis}, last sale ${String(sold.lastSale || '').slice(0, 10)}` };
  const summary = action === 'offer'
    ? `${grade} listed at C$${l.priceCad.toFixed(0)}; it sells for ~C$${market.toFixed(0)}. An offer of C$${maxItem} makes it a deal.`
    : action === 'auction'
      ? `${grade} auction at C$${l.priceCad.toFixed(0)} with ${l.bids ?? 0} bids; worth bidding up to C$${maxItem}.`
      : `${grade} at C$${cost.toFixed(0)} all-in vs ~C$${market.toFixed(0)} eBay sold median.`;
  const fullSummary = summaryNote ? `${summary} ${summaryNote}` : summary;
  log(`slab ${l.id}: ${grade} cost C$${cost.toFixed(0)} market C$${market.toFixed(0)} → ${tier} (${action})`);
  return {
    stage: tier === 'pass' ? 1 : 3, tier, action, price: l.priceCad, cost: showCost, resale, profit: showProfit, roi: showRoi, lines: [line], bulk: 0,
    offer: action === 'buy' ? null : maxItem, maxItem,
    ident: { kind: 'graded', fakeRisk: 'low', summary: fullSummary, askSeller: '', hiddenUpside: '', grade, sales: sold.sales },
  };
}
