import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadConfig, log } from './util.mjs';
import { sendFacebookMessage, browserBusy } from './sources/facebook.mjs';

// Messages Ryan tapped Send on in the app wait in its outbox; the Mac sends them here,
// one at a time, capped per day so Facebook doesn't flag the account.
const capFile = path.join(DATA, 'messages-sent.json');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

function sentToday() {
  const d = fs.existsSync(capFile) ? JSON.parse(fs.readFileSync(capFile, 'utf8')) : {};
  return d[today()] || 0;
}
function countSent() {
  const d = fs.existsSync(capFile) ? JSON.parse(fs.readFileSync(capFile, 'utf8')) : {};
  d[today()] = (d[today()] || 0) + 1;
  fs.writeFileSync(capFile, JSON.stringify(d));
}

async function api(cfg, method, body) {
  const res = await fetch(new URL('/api/agent/outbox', cfg.appUrl), { signal: AbortSignal.timeout(30_000),
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.agentToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`outbox ${method} ${res.status}`);
  return res.json();
}

const waiting = new Set();
export async function processOutbox() {
  const cfg = loadConfig();
  if (!cfg.appUrl || !cfg.agentToken) return;
  let items;
  try { ({ items } = await api(cfg, 'GET')); } catch (e) { log('outbox fetch failed', e.message); return; }
  for (const it of items) {
    // A Marketplace search has the browser: leave it queued, the next loop (~20 s after) retries.
    if (it.id.startsWith('facebook:') && browserBusy()) { if (!waiting.has(it.id)) log(`outbox ${it.id}: waiting for the Marketplace search to finish`); waiting.add(it.id); return; }
    let result;
    if (sentToday() >= cfg.maxMessagesPerDay) {
      result = { state: 'failed', error: `Daily cap of ${cfg.maxMessagesPerDay} messages reached; send it yourself or wait until tomorrow.` };
    } else if (!it.id.startsWith('facebook:')) {
      result = { state: 'failed', error: 'Only Marketplace messages can be sent by the bot for now. Open the listing and send it yourself.' };
    } else {
      try {
        await sendFacebookMessage(cfg, it.url, it.text);
        countSent();
        result = { state: 'sent' };
      } catch (e) {
        result = { state: 'failed', error: e.message.slice(0, 200) };
      }
    }
    log(`outbox ${it.id}: ${result.state}${result.error ? ' — ' + result.error : ''}`);
    await api(cfg, 'POST', { id: it.id, ...result }).catch(e => log('outbox report failed', e.message));
  }
}
