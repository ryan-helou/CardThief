import { fetchText } from '../util.mjs';

// Kijiji is a Next.js app: every page embeds its data as JSON in __NEXT_DATA__.
function apolloState(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('kijiji: no __NEXT_DATA__ (layout changed or blocked)');
  return JSON.parse(m[1]).props.pageProps.__APOLLO_STATE__ || {};
}

function normalize(v) {
  const amount = v.price?.amount;
  return {
    source: 'kijiji',
    id: `kijiji:${v.id}`,
    url: v.url,
    title: v.title,
    description: v.description || '',
    priceCad: typeof amount === 'number' ? amount / 100 : null,
    priceType: v.price?.type || null,
    shippingCad: 0,
    location: v.location?.name || v.location?.address || '',
    postedAt: v.activationDate,
    images: v.imageUrls || [],
    imageCount: v.imageCount ?? (v.imageUrls || []).length,
    promoted: v.adSource !== 'ORGANIC',
  };
}

// One search results page → listings (newest first). Promoted ads are dropped.
export async function searchKijiji(url) {
  const ap = apolloState(await fetchText(url));
  return Object.entries(ap)
    .filter(([k, v]) => k.startsWith('StandardListing:') && v?.adSource === 'ORGANIC')
    .map(([, v]) => normalize(v));
}

// The listing page has the full description and every photo (search only has the first).
export async function kijijiDetail(listing) {
  const ap = apolloState(await fetchText(listing.url));
  const rawId = listing.id.replace('kijiji:', '');
  const v = Object.values(ap).find(x => x?.id === rawId && x?.title);
  if (!v) return listing;
  const full = normalize({ ...v, adSource: 'ORGANIC' });
  // 640px is plenty for the judge to read card names/numbers.
  full.images = full.images.map(u => u.replace(/rule=kijijica-\d+-(jpg|webp)/, 'rule=kijijica-960-jpg'));
  return { ...listing, ...full };
}
