import fs from 'node:fs';
import path from 'node:path';
import { fetchJson as rawFetchJson, log, DATA } from '../util.mjs';

// Every eBay call is counted per day: the free limit is 5,000.
const callsFile = path.join(DATA, 'ebay-calls.json');
const day = () => new Date().toISOString().slice(0, 10);
export function ebayCallsToday() {
  try { const c = JSON.parse(fs.readFileSync(callsFile, 'utf8')); return c.day === day() ? c.n : 0; } catch { return 0; }
}
async function fetchJson(url, opts) {
  if (url.includes('api.ebay.com/buy/')) fs.writeFileSync(callsFile, JSON.stringify({ day: day(), n: ebayCallsToday() + 1 }));
  return rawFetchJson(url, opts);
}

// eBay Browse API (free, 5,000 calls/day). Needs EBAY_CLIENT_ID + EBAY_CLIENT_SECRET
// (production keyset from developer.ebay.com) in config.local.json → ebayKeys.
let token = null;
let tokenExpires = 0;

async function getToken(keys) {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const basic = Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString('base64');
  const res = await fetchJson('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  token = res.access_token;
  tokenExpires = Date.now() + res.expires_in * 1000;
  return token;
}

export function ebayReady(cfg) {
  return Boolean(cfg.ebayKeys?.clientId && cfg.ebayKeys?.clientSecret);
}

function toCad(value, currency, fx) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (currency === 'CAD') return n;
  if (currency === 'USD') return n * fx.USD;
  if (currency === 'EUR') return n * fx.EUR;
  return null;
}

// Newly listed items for one query, posted after `since`.
export async function searchEbay(cfg, query, since, fx) {
  const t = await getToken(cfg.ebayKeys);
  // Auction queries look at what ends soon; everything else at what was listed since the last poll.
  const window = query.endWithinMin
    ? `itemEndDate:[..${new Date(Date.now() + query.endWithinMin * 60e3).toISOString()}]`
    : `itemStartDate:[${since.toISOString()}..]`;
  const filters = [query.filter, window].filter(Boolean).join(',');
  const params = new URLSearchParams({ q: query.q, sort: query.sort || 'newlyListed', limit: '100', filter: filters });
  if (query.categoryIds) params.set('category_ids', query.categoryIds);
  const res = await fetchJson(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      authorization: `Bearer ${t}`,
      'X-EBAY-C-MARKETPLACE-ID': cfg.ebay.marketplace,
      // Prices shipping to Ryan's door; eBay wants the value URL-encoded.
      'X-EBAY-C-ENDUSERCTX': `contextualLocation=${encodeURIComponent('country=CA,zip=H7T2W7')}`,
    },
  });
  return (res.itemSummaries || []).map(it => {
    const ship = it.shippingOptions?.[0]?.shippingCost;
    const fromCanada = it.itemLocation?.country === 'CA';
    // Unknown (calculated) shipping: assume a typical tracked card parcel, and say so.
    const shipCad = ship ? toCad(ship.value, ship.currency, fx) : null;
    return {
      source: 'ebay',
      id: `ebay:${it.legacyItemId || it.itemId}`,
      itemId: it.itemId,
      url: it.itemWebUrl,
      title: it.title,
      description: it.shortDescription || '',
      priceCad: toCad((it.price || it.currentBidPrice)?.value, (it.price || it.currentBidPrice)?.currency, fx),
      priceNative: it.price ? `${it.price.value} ${it.price.currency}` : null,
      shippingCad: shipCad ?? (fromCanada ? 15 : 30),
      shippingEstimated: shipCad == null,
      buyingOptions: it.buyingOptions || [],
      bids: it.bidCount ?? null,
      endsAt: it.itemEndDate || null,
      location: [it.itemLocation?.city, it.itemLocation?.stateOrProvince, it.itemLocation?.postalCode, it.itemLocation?.country].filter(Boolean).join(', '),
      country: it.itemLocation?.country || null,
      seller: it.seller ? `${it.seller.username} (${it.seller.feedbackPercentage}% / ${it.seller.feedbackScore})` : '',
      postedAt: it.itemCreationDate,
      images: [it.image?.imageUrl, ...(it.additionalImages || []).map(i => i.imageUrl)].filter(Boolean),
      condition: it.condition || '',
    };
  });
}

// getItem gives every photo and the full description; only called for candidates.
export async function ebayDetail(cfg, listing, fx) {
  try {
    const t = await getToken(cfg.ebayKeys);
    const it = await fetchJson(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(listing.itemId)}`, {
      headers: { authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': cfg.ebay.marketplace },
    });
    const images = [it.image?.imageUrl, ...(it.additionalImages || []).map(i => i.imageUrl)].filter(Boolean);
    const descriptors = (it.conditionDescriptors || []).map(d => `${d.name}: ${(d.values || []).map(v => v.content).join('/')}`);
    return {
      ...listing,
      images: images.length ? images : listing.images,
      description: (it.shortDescription || it.description || listing.description || '').replace(/<[^>]+>/g, ' ').slice(0, 3000),
      condition: [it.condition, ...descriptors].filter(Boolean).join('; '),
    };
  } catch (e) {
    log('ebay detail failed', listing.id, e.message);
    return listing;
  }
}

// Free price check: the same card in the same grade, for sale right now (Buy It Now, ships to Canada),
// all-in to H7T 2W7. A slab is only interesting if it's clearly cheaper than these.
const compCache = new Map();
export async function activeComps(cfg, card, grade, selfId, fx, { japanese = false } = {}) {
  const num = String(card.number).split('/')[0].replace(/^0+(?=\d)/, '');
  const [grader, g] = grade.split(' ');
  const key = `${card.name}|${num}|${grade}|${japanese}`.toLowerCase();
  const hit = compCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  if (ebayCallsToday() >= (cfg.slabs?.maxEbayCallsPerDay ?? 4500)) return null; // keep headroom for searches
  const t = await getToken(cfg.ebayKeys);
  const params = new URLSearchParams({
    q: `${card.name} ${num} ${grader} ${g}${japanese ? ' japanese' : ''}`, category_ids: '183454', sort: 'price', limit: '50',
    filter: 'conditionIds:{2750},deliveryCountry:CA,buyingOptions:{FIXED_PRICE}',
  });
  const res = await fetchJson(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': cfg.ebay.marketplace, 'X-EBAY-C-ENDUSERCTX': `contextualLocation=${encodeURIComponent('country=CA,zip=H7T2W7')}` },
  });
  const gradeRe = new RegExp(`\\b${grader}\\s*-?\\s*${g.replace('.', '\\.')}(?![\\d.])`, 'i');
  const numRe = new RegExp(`(#|\\b)0*${num}\\b`);
  const tax = cfg.money.buyerTaxOnline;
  const prices = (res.itemSummaries || [])
    .filter(it => `ebay:${it.legacyItemId}` !== selfId && gradeRe.test(it.title) && numRe.test(it.title))
    .filter(it => !/korean|chinese|\blot\b|bundle|\bx\d|\d+x\b/i.test(it.title))
    .filter(it => japanese === /japan|japon|\bjp\b|jpn/i.test(it.title))
    .map(it => {
      const p = toCad(it.price?.value, it.price?.currency, fx);
      const s = it.shippingOptions?.[0]?.shippingCost;
      const ship = s ? toCad(s.value, s.currency, fx) : (it.itemLocation?.country === 'CA' ? 15 : 30);
      return (p + ship) * (1 + tax);
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const v = { count: prices.length, cheapest: prices[0] ?? null, median: prices.length ? prices[Math.floor(prices.length / 2)] : null };
  compCache.set(key, { at: Date.now(), v });
  return v;
}
