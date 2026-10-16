import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, log } from './util.mjs';
import { quoteLot } from './judge.mjs';

// Picks up quotes Ryan requested from the app (photos of a collection), values them, posts the result back.
async function api(method, body) {
  const cfg = loadConfig();
  if (!cfg.appUrl || !cfg.agentToken) return null;
  const res = await fetch(new URL('/api/agent/quotes', cfg.appUrl), {
    method, signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${cfg.agentToken}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`quotes ${method} ${res.status}`);
  return res.json();
}

let busy = false;
export async function processQuotes(cfg) {
  if (busy) return; // one at a time; the drain loop and the main loop both call this
  busy = true;
  try {
    for (let i = 0; i < 3; i++) {
      const { quote } = (await api('GET')) || {};
      if (!quote) return;
      const dir = path.join(DATA, 'img', `quote_${quote.id}`);
      fs.mkdirSync(dir, { recursive: true });
      quote.photos.forEach((p, n) => fs.writeFileSync(path.join(dir, `${n + 1}.jpg`), Buffer.from(p.split(',')[1] || '', 'base64')));
      try {
        const result = await quoteLot(cfg, quote, dir);
        await api('POST', { id: quote.id, result: { ...result, photoCount: quote.photos.length } });
        log(`quote ${quote.id}: ${quote.photos.length} photos → resale C$${result.resale.toFixed(0)}, max to pay C$${result.offerGood}`);
      } catch (e) {
        log('quote failed', quote.id, e.message);
        await api('POST', { id: quote.id, failed: true, result: { summary: '', totalCards: null, resale: 0, marketTotal: 0, offerSteal: 0, offerGood: 0, profitAtAsking: null, lines: [], askSeller: '', fakeRisk: 'low', error: e.message.slice(0, 200), photoCount: quote.photos.length } }).catch(() => {});
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (e) {
    log('quotes check failed', e.message);
  } finally {
    busy = false;
  }
}
