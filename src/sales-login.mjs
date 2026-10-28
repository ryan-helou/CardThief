// Opens the sold-prices Chrome profile on eBay and Card Ladder so Ryan can log into both once.
// The hit list reuses the saved sessions from then on. Close the eBay tab when you're done.
import { openSalesBrowser } from './sources/sold.mjs';

const ctx = await openSalesBrowser({ headless: false });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://signin.ebay.com/');
const cl = await ctx.newPage();
await cl.goto('https://app.cardladder.com/login');
console.log('Log into eBay (tick "Stay signed in") and Card Ladder in the window that opened, then close the eBay tab.');
// On a Mac, closing the last window leaves Chrome running, so wait for the tab to close instead.
await new Promise(r => { page.on('close', r); ctx.on('close', r); });
await ctx.close().catch(() => {});
console.log('Saved. The hit list will use these logins.');
