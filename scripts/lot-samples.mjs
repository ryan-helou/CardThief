// Pulls a few real raw binder/collection listings with many photos from eBay, for testing lot reading.
import fs from 'node:fs';
import { loadConfig } from '../src/util.mjs';
import { getToken } from '../src/sources/ebay.mjs';
const cfg = loadConfig();
const t = await getToken(cfg.ebayKeys);
const params = new URLSearchParams({ q: 'pokemon binder collection lot holo', category_ids: '183454', limit: '40', filter: 'conditionIds:{4000},buyingOptions:{FIXED_PRICE},price:[40..400],priceCurrency:USD' });
const r = await (await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, { headers: { authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } })).json();
const out = [];
for (const it of r.itemSummaries || []) {
  if (out.length >= 3) break;
  const d = await (await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(it.itemId)}`, { headers: { authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } })).json();
  const images = [d.image?.imageUrl, ...(d.additionalImages || []).map(i => i.imageUrl)].filter(Boolean).map(u => u.replace(/s-l\d+\./, 's-l1600.'));
  if (images.length < 5) continue;
  out.push({ id: `test:${it.legacyItemId}`, source: 'quote', title: d.title, description: (d.shortDescription || d.description || '').replace(/<[^>]+>/g, ' ').slice(0, 1500), priceCad: Number(d.price.value) * 1.37, images: images.slice(0, 10), url: it.itemWebUrl });
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(out.map(o => `${o.images.length} photos  US$${(o.priceCad / 1.37).toFixed(0)}  ${o.title}`).join('\n'));
process.exit(0);
