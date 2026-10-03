// Opens the bot's own Chrome profile on Facebook so Ryan can log in once.
// The bot reuses the saved session from then on. Close the window when you're done.
import { openBrowser } from './sources/facebook.mjs';

const ctx = await openBrowser({ headless: false });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.facebook.com/marketplace/montreal/');
console.log('Log into Facebook in the window that opened, check Marketplace loads, then close the window.');
await new Promise(r => ctx.on('close', r));
console.log('Saved. The bot will use this login.');
