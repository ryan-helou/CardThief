// Re-identifies slab titles Mint couldn't price, to measure naming fixes (free: TCGdex only).
import fs from 'node:fs';
import { DATA } from '../src/util.mjs';
import { identify } from '../src/slabs.mjs';
const n = Number(process.argv[2] || 40);
const rows = fs.readFileSync(`${DATA}/judged.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(r => r.id.startsWith('ebay') && /no eBay sold data for/.test(r.summary || '') && !/japan|jpn|\bjp\b/i.test(r.title)).slice(-n);
let changed = 0;
for (const r of rows) {
  const old = r.summary.match(/no eBay sold data for (.*?) \S+ (PSA|CGC|BGS|SGC|TAG|ACE) [\d.]+$/)?.[1] || '?';
  const id = await identify(r.title).catch(() => null);
  const now = id ? `${id.card.name} ${id.card.number}` : '(none → AI label read)';
  if (!now.startsWith(old)) changed++;
  console.log(`${r.title.slice(0, 70)}\n   was: ${old}   now: ${now}`);
}
console.log(`${changed}/${rows.length} changed`);
process.exit(0);
