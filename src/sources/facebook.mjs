import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA, log, sleep, jitter } from '../util.mjs';

// Facebook Marketplace has no API and redirects logged-out visitors to login, so the bot
// drives real Chrome with its own profile (data/fb-profile) that Ryan logs into once
// via `npm run fb-login`. One browser per sweep, closed afterwards, paced like a person.
export const PROFILE = path.join(DATA, 'fb-profile');

export async function openBrowser({ headless }) {
  return chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export function inActiveHours(cfg, d = new Date()) {
  const h = Number(d.toLocaleString('en-CA', { hour: 'numeric', hour12: false, timeZone: 'America/Toronto' })) % 24;
  return h >= cfg.facebook.activeHours[0] && h < cfg.facebook.activeHours[1];
}

const searchUrl = (cfg, q) =>
  `https://www.facebook.com/marketplace/${cfg.facebook.city}/search?` +
  new URLSearchParams({ query: q, daysSinceListed: '1', maxPrice: String(cfg.maxBuyCad), exact: 'false' });

function parsePrice(s) {
  if (!s) return null;
  if (/gratuit|free/i.test(s)) return 0;
  const m = s.replace(/\s/g, '').match(/(\d[\d,.]*)/);
  return m ? Number(m[1].replace(/[,.](?=\d{3}\b)/g, '').replace(',', '.')) : null;
}

async function loggedOut(page) {
  return page.url().includes('/login') || (await page.locator('input[name="email"]').count()) > 0;
}

// Result tiles are links to /marketplace/item/<id>/ whose text is "price\n[old price]\ntitle\nlocation".
async function readTiles(page) {
  return page.$$eval('a[href*="/marketplace/item/"]', as =>
    as.map(a => {
      const id = a.href.match(/\/marketplace\/item\/(\d+)/)?.[1];
      const lines = a.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      const img = a.querySelector('img')?.src || null;
      return { id, lines, img };
    }).filter(t => t.id && t.lines.length >= 2),
  );
}

export async function sweepFacebook(cfg) {
  const ctx = await openBrowser({ headless: cfg.facebook.headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const found = new Map();
  try {
    for (const q of cfg.facebook.queries) {
      await page.goto(searchUrl(cfg, q), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(jitter(4000));
      if (await loggedOut(page)) throw new Error('facebook: logged out — run `npm run fb-login`');
      // Scroll a little, as a person would, so more tiles load.
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 900 + Math.random() * 600); await sleep(jitter(1800)); }
      const tiles = await readTiles(page);
      for (const t of tiles) {
        if (found.has(t.id)) continue;
        const priceLine = t.lines.find(s => /\$|gratuit|free/i.test(s)) || t.lines[0];
        // Drop badges ("Just listed") and struck-through old prices ("CA$110").
        const rest = t.lines.filter(s => s !== priceLine && !/^(CA)?\$|^\d[\d\s,.]*\s?\$$|^just listed$|^nouveau|^vient d/i.test(s));
        found.set(t.id, {
          source: 'facebook',
          id: `facebook:${t.id}`,
          url: `https://www.facebook.com/marketplace/item/${t.id}/`,
          title: rest[0] || '',
          description: '',
          priceCad: parsePrice(priceLine),
          shippingCad: 0,
          location: rest[1] || '',
          postedAt: new Date().toISOString(), // search is limited to the last day; first sighting = new
          images: t.img ? [t.img] : [],
        });
      }
      log(`facebook "${q}": ${tiles.length} tiles`);
      await sleep(jitter(cfg.facebook.pauseBetweenQueriesSec * 1000));
    }
  } finally {
    await ctx.close();
  }
  return [...found.values()];
}

// Listing page: full description and every photo. Opened only for candidates.
export async function facebookDetail(cfg, listing) {
  const ctx = await openBrowser({ headless: cfg.facebook.headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(jitter(3500));
    if (await loggedOut(page)) throw new Error('facebook: logged out — run `npm run fb-login`');
    const info = await page.evaluate(() => {
      const main = document.querySelector('[role="main"]') || document.body;
      const imgs = [...main.querySelectorAll('img')]
        .filter(i => /scontent|fbcdn/.test(i.src) && (i.naturalWidth >= 300 || i.width >= 200))
        .map(i => i.src);
      const title = main.querySelector('h1')?.innerText || '';
      // Stop before the seller's profile and the ads: only the listing itself is needed.
      const text = main.innerText.split(/\n(Seller information|Informations sur le vendeur|Today's picks|Sponsored)\n/)[0];
      return { text: text.slice(0, 4000), imgs: [...new Set(imgs)], title };
    });
    // Thumbnail strip: click through so the larger photos load.
    const thumbs = page.locator('[role="main"] [aria-label*="Thumbnail"], [role="main"] div[role="button"] img');
    const n = Math.min(await thumbs.count().catch(() => 0), 8);
    const more = [];
    for (let i = 0; i < n; i++) {
      await thumbs.nth(i).click({ timeout: 2000 }).catch(() => {});
      await sleep(600);
      const src = await page.evaluate(() => {
        const big = [...document.querySelectorAll('[role="main"] img')].filter(i => i.naturalWidth >= 500).map(i => i.src);
        return big[0] || null;
      });
      if (src) more.push(src);
    }
    const images = [...new Set([...more, ...info.imgs, ...listing.images])].slice(0, 8);
    return { ...listing, title: info.title || listing.title, description: info.text, images };
  } finally {
    await ctx.close();
  }
}
