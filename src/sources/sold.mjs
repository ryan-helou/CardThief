import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA } from '../util.mjs';

// Sold prices for the show hit list come from eBay's sold search and Card Ladder, both behind a
// login, so they get their own Chrome profile (data/sales-profile) that Ryan logs into once via
// `npm run sales-login`. Kept apart from the Facebook profile so the two never fight over a lock.
export const PROFILE = path.join(DATA, 'sales-profile');

// Headless Chrome announces itself as "HeadlessChrome" and eBay answers that with an error page, so
// the hidden runs send an ordinary Chrome user-agent. Only the login helper opens a visible window.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

export async function openSalesBrowser({ headless = true } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Toronto',
    ...(headless ? { userAgent: UA } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
  });
  if (headless) await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return ctx;
}
