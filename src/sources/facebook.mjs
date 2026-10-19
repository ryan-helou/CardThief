import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA, log, sleep, jitter } from '../util.mjs';

// Facebook Marketplace has no API and redirects logged-out visitors to login, so the bot
// drives real Chrome with its own profile (data/fb-profile) that Ryan logs into once
// via `npm run fb-login`. One browser per sweep, closed afterwards, paced like a person.
export const PROFILE = path.join(DATA, 'fb-profile');

// Only one Chrome can use the profile at a time. Sweeps run in the background, so everything that
// opens it goes through this lock; callers that shouldn't wait check browserBusy() first.
let lock = Promise.resolve(), holders = 0;
export const browserBusy = () => holders > 0;
async function withBrowser(cfg, fn) {
  holders++;
  const prev = lock;
  let release;
  lock = new Promise(r => (release = r));
  await prev;
  try {
    const ctx = await openBrowser({ headless: cfg.facebook.headless });
    try { return await fn(ctx); } finally { await Promise.race([ctx.close(), sleep(30_000)]).catch(() => {}); }
  } finally { holders--; release(); }
}

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
  new URLSearchParams({ query: q, daysSinceListed: '1', maxPrice: String(cfg.local?.maxBuyCad ?? cfg.maxBuyCad), exact: 'false' });

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

export const sweepFacebook = cfg => withBrowser(cfg, ctx => sweep(cfg, ctx));
async function sweep(cfg, ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const found = new Map();
  // Chrome sometimes crawls (one sweep took 58 minutes): cap the sweep and every step in it.
  const deadline = Date.now() + (cfg.facebook.maxSweepMin ?? 8) * 60e3;
  const capped = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
  try {
    for (const q of cfg.facebook.queries) {
      if (Date.now() > deadline) { log(`facebook sweep cut short at ${found.size} listings (over ${cfg.facebook.maxSweepMin ?? 8} min)`); break; }
      // One slow search shouldn't sink the whole sweep: skip it and keep going.
      try {
        await page.goto(searchUrl(cfg, q), { waitUntil: 'domcontentloaded', timeout: 90_000 });
      } catch (e) {
        if (/logged out/.test(e.message)) throw e;
        log(`facebook "${q}" skipped: ${e.message.split('\n')[0]}`);
        continue;
      }
      await sleep(jitter(4000));
      let tiles;
      try {
        if (await capped(loggedOut(page), 20_000, 'login check')) throw new Error('facebook: logged out — run `npm run fb-login`');
        // Scroll a little, as a person would, so more tiles load.
        for (let i = 0; i < 2; i++) { await capped(page.mouse.wheel(0, 900 + Math.random() * 600), 20_000, 'scroll'); await sleep(jitter(1800)); }
        tiles = await capped(readTiles(page), 30_000, 'reading results');
      } catch (e) {
        if (/logged out/.test(e.message)) throw e;
        log(`facebook "${q}" skipped: ${e.message}`);
        continue;
      }
      for (const t of tiles) {
        if (found.has(t.id)) continue;
        const priceLine = t.lines.find(s => /\$|gratuit|free/i.test(s)) || t.lines[0];
        // Drop badges ("Just listed") and struck-through old prices ("CA$110").
        const rest = t.lines.filter(s => s !== priceLine && !/^(CA)?\$|^\d[\d\s,.]*\s?\$$|^just listed$|^nouveau|^vient d|^pending$|^en attente$|^·$/i.test(s));
        if (t.lines.some(s => /^(pending|en attente|sold|vendu)$/i.test(s))) continue;
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
  } finally {}
  return [...found.values()];
}

// Listing page: full description and every photo. Opened only for candidates.
export const facebookDetail = (cfg, listing) => withBrowser(cfg, ctx => detail(listing, ctx));
async function detail(listing, ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  {
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
    // Binder and collection posts hide the valuable pages deep in the photo strip: open up to 12.
    const n = Math.min(await thumbs.count().catch(() => 0), 12);
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
    const images = [...new Set([...more, ...info.imgs, ...listing.images])].slice(0, 12);
    return { ...listing, title: info.title || listing.title, description: info.text, images };
  }
}

// Sends one message to a listing's seller. Only ever called for a message Ryan tapped
// Send on in the app. dryRun types the text but stops before sending (for testing).
export const sendFacebookMessage = (cfg, url, text, opts = {}) => withBrowser(cfg, ctx => send(url, text, opts, ctx));
async function send(url, text, { dryRun = false, shot = null }, ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(jitter(4000));
    if (await loggedOut(page)) throw new Error('facebook: logged out — run `npm run fb-login`');
    const main = page.locator('[role="main"]');
    if (await main.getByText(/^(Sold|Vendu|Pending|En attente)$/).count()) throw new Error('listing is sold or pending');

    // Either an inline "Send seller a message" box, or a Message button that opens a chat.
    if (await page.getByText(/listing isn.t available anymore|annonce n.est plus disponible/i).count()) throw new Error('listing is gone');
    let box = main.locator('textarea:visible').first();
    if (!(await box.isVisible().catch(() => false))) {
      await main.getByRole('button', { name: /^(Message|Envoyer un message|Contacter)$/i }).first().click({ timeout: 8000 });
      await sleep(jitter(2500));
      box = page.locator('[role="dialog"] textarea, [role="dialog"] [contenteditable="true"][role="textbox"], [aria-label*="Message"][contenteditable="true"]').last();
    }
    await box.click({ timeout: 8000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 35 + Math.random() * 40 });
    await sleep(jitter(1200));
    if (shot) await page.screenshot({ path: shot });
    if (dryRun) return { ok: true, dryRun: true };

    // Inline box: "Send message to <seller>"; chat dialog: "Send"/"Press enter to send".
    const send = (await box.evaluate(b => !!b.closest('[role="dialog"]')).catch(() => false))
      ? page.locator('[role="dialog"]').getByRole('button', { name: /^(Send|Envoyer|Press enter to send|Appuyez sur Entrée)/i }).last()
      : main.getByRole('button', { name: /^(Send message to|Envoyer un message à|Envoyer le message)/i }).first();
    if (await send.isVisible().catch(() => false)) await send.click();
    else await page.keyboard.press('Enter');
    await sleep(jitter(3500));
    // Sent once the text appears in the conversation and the box no longer holds it.
    const stillTyped = (await box.innerText().catch(() => box.inputValue().catch(() => ''))).includes(text.slice(0, 20));
    if (stillTyped) throw new Error('message did not send (still in the box)');
    return { ok: true };
  }
}
