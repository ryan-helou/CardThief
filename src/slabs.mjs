import fs from 'node:fs';
import path from 'node:path';
import { DATA, log } from './util.mjs';
import { priceCard, getFx } from './price.mjs';
import { pptPrice, pptAvailable } from './ppt.mjs';
import { parseTitle, verifySlabPhotos, identifySlabAI } from './judge.mjs';
import { activeComps, ebayDetail } from './sources/ebay.mjs';
import { checkPsaCert, certFromListing } from './psa.mjs';

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
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.p;
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
  if (/korean|chinese|s-chinese|t-chinese/i.test(l.title)) return pass('Korean/Chinese slab (no sold data)');
  let japanese = /japan|japon|\bjp\b|jpn/i.test(l.title);
  if (japanese && !s.allowJapanese) return pass('Japanese slab (turned off)');
  // Item specifics (grader/grade fields, all photos) only when the title lacks a grade: saves eBay calls.
  if (!slabGrade(l)) l = await ebayDetail(cfg, l, fx);
  let grade = slabGrade(l);
  // Japanese numbering isn't in the free English catalog: take name + number straight from the title.
  const jpId = t => {
    const p = parseTitle(t);
    const hash = t.match(/#\s?(\d{1,3})\b/);
    const number = p.number || hash?.[1];
    const after = hash ? t.slice(hash.index + hash[0].length).split(/\b(PSA|CGC|BGS|SGC|TAG|ACE)\b/i)[0].replace(/[^\p{L}\s'.-]/gu, ' ').trim().split(/\s+/).slice(0, 3).join(' ') : '';
    const name = p.name || after;
    return name && number ? { card: { name, number, setTotal: p.setTotal, variant: p.variant }, raw: null } : null;
  };
  let id = grade ? (japanese ? jpId(l.title) : await identify(l.title)) : null;
  let usedAI = false;
  // Title didn't say which card or grade: read the slab label from the photos instead.
  if (!grade || !id) {
    const ai = await identifySlabAI(cfg, l).catch(e => { log('slab id failed', e.message); return null; });
    usedAI = true;
    if (!ai?.isSingleSlab) return pass('not a single graded card', { stage: 2 });
    if (ai.language === 'other') return pass('Korean/Chinese slab (no sold data)', { stage: 2 });
    if (ai.language === 'jp') { if (!s.allowJapanese) return pass('Japanese slab (turned off)', { stage: 2 }); japanese = true; }
    if (!grade && ai.grader && ai.grade) grade = `${ai.grader.toUpperCase()} ${ai.grade}`;
    if (!grade) return pass('no grade found', { stage: 2 });
    if (!id && ai.name && ai.number) {
      id = (!japanese && await identify(`${ai.name} ${ai.number}`)) || { card: { name: ai.name, number: ai.number, setTotal: Number(String(ai.number).split('/')[1]) || null, variant: 'unknown' }, raw: null };
    }
    if (!id) return pass(`couldn't read the card from the photos either`, { stage: 2 });
  }
  const [grader, num] = grade.split(' ');
  if (!s.graders.includes(grader)) return pass(`grader ${grader} not tracked`, { stage: usedAI ? 2 : 1 });
  if (Number(num) < s.minGrade) return pass(`${grade} below minimum grade`);

  const tax = (l.priceCad + (l.shippingCad || 0)) * m.buyerTaxOnline;
  const cost = l.priceCad + (l.shippingCad || 0) + tax;
  const card = { ...id.card, grade, language: japanese ? 'jp' : 'en' };
  const raw = id.raw;
  // Free pre-screen: a slab can't be a steal if it already costs more than a generous multiple of the raw card.
  // Skip the ceiling for vintage and 1st Editions: their slabs are worth many times the cheap raw printing.
  const vintage = /1st|first ed|\b(199\d|200\d)\b|wotc|base set|jungle|fossil|team rocket|gym|neo |shadowless/i.test(l.title);
  if (raw && raw.cad >= 15 && !vintage) {
    const ceiling = raw.cad * (Number(num) >= 10 || grade === 'BGS 9.5' ? s.maxGemMultiple : s.maxNineMultiple);
    if (cost > ceiling) return pass(`priced above ${grade} ceiling (raw C$${raw.cad.toFixed(0)})`, { cost });
  }
  const isAuctionL = l.buyingOptions?.includes('AUCTION') && !l.buyingOptions?.includes('FIXED_PRICE');
  // Value first (sold-price lookups are plentiful on the paid plan); eBay "other copies" searches
  // count against eBay's 5,000/day, so they only run for slabs that could be a deal.
  // Asking prices are not values: a Squawkabilly ex PSA 10 was "listed from C$96" while it actually
  // sells for ~US$26 (Collectr, 2026-10-10). Only real sales can make an alert.
  let sold = pptAvailable() ? await gradePrice({ ...card, grade }) : null;
  if (!sold) return pass(`no eBay sold data for ${card.name} ${card.number} ${grade}`, { cost });
  {
    const quickResale = sold.usd * fx.USD * (1 - m.ebaySellFee) - m.ebayOrderFee - s.resaleShipCad;
    const roomForOffer = l.buyingOptions?.includes('BEST_OFFER') && quickResale / (1 + cfg.deal.good.minRoi) >= cost * s.minOfferRatio;
    const roomForBid = isAuctionL && quickResale / (1 + cfg.deal.good.minRoi) > cost;
    if (quickResale - cost < cfg.deal.good.minProfitCad && !roomForOffer && !roomForBid) {
      return pass(`${grade} at C$${cost.toFixed(0)} all-in vs ~C$${(sold.usd * fx.USD).toFixed(0)} (${sold.basis}).`, { cost, resale: quickResale, profit: quickResale - cost, roi: (quickResale - cost) / cost });
    }
  }
  let comps = null;
  try { comps = await activeComps(cfg, card, grade, l.id, fx, { japanese }); } catch (e) { log('active comps failed', e.message); }
  if (comps?.count >= s.minComps) {
    const beatsAll = cost <= comps.cheapest * (1 - s.minBelowCheapest);
    const offerRoom = l.buyingOptions?.includes('BEST_OFFER') && cost <= comps.cheapest * (1 + s.offerSlack);
    if (!beatsAll && !offerRoom && !isAuctionL) return pass(`C$${cost.toFixed(0)} all-in; ${comps.count} others listed from C$${comps.cheapest.toFixed(0)}`, { cost });
  }

  let market = sold.usd * fx.USD;
  // Sanity check: a sold median far above every copy for sale usually means the lookup matched the
  // wrong card (a 25th Anniversary Pikachu PSA 10 came back at C$1,138 while bidding sat at C$50).
  if (comps?.count >= s.minComps && market > comps.cheapest * 2) {
    log(`slab ${l.id}: sold median C$${market.toFixed(0)} vs cheapest listing C$${comps.cheapest.toFixed(0)}, capping`);
    market = comps.cheapest / (1 + m.buyerTaxOnline);
    sold = { ...sold, basis: `${sold.basis}, capped at cheapest other listing (median looked wrong)` };
  }
  // Thin sold data must be backed by the live market: a JP 1st Ed M Tyranitar EX PSA 10 showed
  // US$418 from 5 sales (likely another printing) while it really sells for ~US$150 (PriceCharting).
  if ((sold.sales ?? 0) < (s.minSalesAlone ?? 20) && !(comps?.count >= s.minComps && market <= comps.cheapest * 1.5)) {
    return pass(`only ${sold.sales} sales and the live listings don't back up C$${market.toFixed(0)}`, { cost });
  }
  if ((sold.sales ?? 0) < 5 && (!comps || comps.count < s.minComps)) {
    return pass(`too little sold data to trust (${sold.sales} sales) and no other copies to compare`, { cost });
  }
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
    // A busy auction's current bid says nothing about where it will end.
    if ((l.bids ?? 0) > s.maxBids) return pass(`auction already has ${l.bids} bids`, { cost });
    if (tier === 'pass' && maxItem > l.priceCad * 1.1) tier = 'good';
  } else if (tier === 'pass' && l.buyingOptions?.includes('BEST_OFFER') && maxItem >= l.priceCad * s.minOfferRatio) {
    action = 'offer';
    tier = 'good';
  }
  // Verification gate: an alert needs RECENT proof of value, not just an all-time median.
  const checks = [];
  if (tier !== 'pass') {
    const lastDays = sold.lastSale ? (Date.now() - new Date(sold.lastSale)) / 864e5 : 999;
    if (!sold.recent && lastDays > 30) return pass(`no sales in the last 30 days to confirm the ${grade} price`, { cost, stage: 3 });
    if (sold.weekly != null && sold.weekly < 0.25 && lastDays > 45) return pass(`too illiquid to flip (${sold.weekly.toFixed(1)} sales/week)`, { cost, stage: 3 });
    checks.push(`✓ value from ${sold.recent ? 'last-7-day sales' : 'a sale in the last 30 days'}${sold.trend === 'down' ? ' (falling; lower figure used)' : ''}`);
    checks.push(`✓ card matched (${card.name} ${card.number}, ${japanese ? 'Japanese' : 'English'})`);
    if (comps?.count) checks.push(`✓ ${comps.count} other ${grade} copies listed, cheapest C$${comps.cheapest.toFixed(0)} all-in`);
    if (sold.weekly != null) checks.push(`${sold.weekly >= 1 ? '✓' : '•'} sells ~${sold.weekly.toFixed(1)}×/week`);
  }
  // For offers and auctions, show the numbers at the suggested price, not the current one.
  let showCost = cost, showProfit = profit, showRoi = roi;
  if (action !== 'buy' && tier !== 'pass') {
    showCost = (maxItem + (l.shippingCad || 0)) * (1 + m.buyerTaxOnline);
    showProfit = resale - showCost;
    showRoi = showProfit / showCost;
  }
  if (tier !== 'pass') {
    // Alert candidate: full listing (item specifics hold the cert), photo check (also reads the cert off the label), then PSA.
    if (!certFromListing(l)) l = await ebayDetail(cfg, l, fx);
    const v = await verifySlabPhotos(cfg, l, `${card.name} ${card.number}`, grade).catch(e => ({ ok: true, note: `photo check skipped: ${e.message}`, cert: null }));
    if (!v.ok) return pass(`photo check failed: ${v.note}`, { cost, stage: 3 });
    summaryNote = v.note;
    // Priced off other listings? Re-check them using the name read off the label, in case the title parse was off.
    if (!sold.sales && v.cardName && v.cardName.toLowerCase() !== String(card.name).toLowerCase()) {
      const c2 = await activeComps(cfg, { ...card, name: v.cardName }, grade, l.id, fx, { japanese }).catch(() => null);
      if (c2?.count >= s.minComps) {
        const m2 = c2.cheapest / (1 + m.buyerTaxOnline);
        const r2 = m2 * (1 - m.ebaySellFee) - m.ebayOrderFee - s.resaleShipCad;
        const p2 = r2 - cost, roi2 = p2 / cost;
        const ok2 = (p2 >= good.minProfitCad && roi2 >= good.minRoi) || (action !== 'buy' && r2 / (1 + good.minRoi) > cost * 0.75);
        if (!ok2) return pass(`re-priced as ${v.cardName}: ${c2.count} others listed from C$${c2.cheapest.toFixed(0)}, not a deal`, { cost, stage: 3 });
      }
    }
    if (grader === 'PSA') {
      const pc = await checkPsaCert(certFromListing(l) || v.cert, card, grade);
      if (pc.checked && !pc.ok) return pass(`cert check failed: ${pc.note}`, { cost, stage: 3 });
      summaryNote = `${pc.note} ${summaryNote}`;
    }
  }
  const compsNote = comps?.count ? ` Cheapest other ${grade} for sale: C$${comps.cheapest.toFixed(0)} all-in (${comps.count} listed).` : '';
  const line = { label: `${card.name} ${card.number} ${grade}`, marketCad: +market.toFixed(2), netCad: +resale.toFixed(2), basis: `${sold.basis}, last sale ${String(sold.lastSale || '').slice(0, 10)}` };
  const summary = tier === 'pass'
    ? `${grade} at C$${cost.toFixed(0)} all-in vs ~C$${market.toFixed(0)} (${sold.basis}).`
    : action === 'offer'
    ? `${grade} listed at C$${l.priceCad.toFixed(0)}; ${sold.sales ? 'it sells for' : 'others are listed from'} ~C$${market.toFixed(0)}. An offer of C$${maxItem} makes it a deal.`
    : action === 'auction'
      ? `${grade} auction at C$${l.priceCad.toFixed(0)} with ${l.bids ?? 0} bids; worth bidding up to C$${maxItem}.`
      : `${grade} at C$${cost.toFixed(0)} all-in vs ~C$${market.toFixed(0)} (${sold.sales ? 'eBay sold median' : 'cheapest other listing, no sold data'}).`;
  const fullSummary = `${summary}${compsNote}${summaryNote ? ' ' + summaryNote : ''}${checks.length ? ` Checks: ${checks.join(' · ')}.` : ''}`;
  log(`slab ${l.id}: ${grade} cost C$${cost.toFixed(0)} market C$${market.toFixed(0)} → ${tier} (${action})`);
  return {
    stage: tier === 'pass' ? (usedAI ? 2 : 1) : 3, tier, action, price: l.priceCad, cost: showCost, resale, profit: showProfit, roi: showRoi, lines: [line], bulk: 0,
    offer: action === 'buy' ? null : maxItem, maxItem,
    ident: { kind: 'graded', fakeRisk: 'low', summary: fullSummary, askSeller: '', hiddenUpside: '', grade, sales: sold.sales },
  };
}
