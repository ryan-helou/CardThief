// Re-judges every past eBay alert with today's rules and data. A rule change must keep the real
// steals and reject the false alarms before it goes live.  node scripts/backtest-alerts.mjs [id…]
import fs from 'node:fs';
import { loadConfig, DATA } from '../src/util.mjs';
import { getFx } from '../src/price.mjs';
import { judgeSlab } from '../src/slabs.mjs';

const cfg = loadConfig();
const fx = await getFx();
const ids = process.argv.slice(2);
const deals = fs.readFileSync(`${DATA}/deals.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(d => d.id.startsWith('ebay:') && (!ids.length || ids.includes(d.id)));
const basic = Buffer.from(`${cfg.ebayKeys.clientId}:${cfg.ebayKeys.clientSecret}`).toString('base64');
const tok = (await (await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope' })).json()).access_token;
const cad = (v, c) => c === 'CAD' ? +v : c === 'USD' ? v * fx.USD : v * (fx[c] || 1);

for (const d of [...new Map(deals.map(d => [d.id, d])).values()]) {
  const itemId = `v1|${d.id.slice(5)}|0`;
  const it = await (await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`, { headers: { authorization: `Bearer ${tok}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_CA', 'X-EBAY-C-ENDUSERCTX': `contextualLocation=${encodeURIComponent('country=CA,zip=H7T2W7')}` } })).json();
  if (!it.title) { console.log(`${d.id}  (listing gone)  ${d.title.slice(0, 60)}`); continue; }
  const ship = it.shippingOptions?.[0]?.shippingCost;
  // Judge at the price Mint saw when it alerted, not the auction's final price.
  const l = {
    source: 'ebay', id: d.id, itemId, url: d.url, title: it.title, description: (it.shortDescription || '').slice(0, 600),
    priceCad: d.price, shippingCad: process.env.SHIP ? +process.env.SHIP : ship ? cad(ship.value, ship.currency) : (it.itemLocation?.country === "CA" ? 15 : 30),
    buyingOptions: process.env.OPTS ? process.env.OPTS.split(",") : it.buyingOptions || [], bids: 0, endsAt: new Date(Date.now() + 30 * 60e3).toISOString(),
    images: [it.image?.imageUrl, ...(it.additionalImages || []).map(i => i.imageUrl)].filter(Boolean),
    seller: it.seller ? `${it.seller.username} (${it.seller.feedbackPercentage}% / ${it.seller.feedbackScore})` : '',
    postedAt: it.itemCreationDate, country: it.itemLocation?.country,
  };
  const r = await judgeSlab(cfg, l).catch(e => ({ tier: 'error', ident: { summary: e.message } }));
  console.log(`${d.id}  was ${d.tier.toUpperCase()} → now ${r.tier.toUpperCase()}  ${d.title.slice(0, 55)}\n    ${(r.ident?.summary || '').slice(0, 260)}`);
}
process.exit(0);
