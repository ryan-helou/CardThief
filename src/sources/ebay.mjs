import { fetchJson, log } from '../util.mjs';

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
