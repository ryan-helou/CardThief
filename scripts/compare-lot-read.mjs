// Compares the one-call lot read with the per-photo deep read on sample lots (lots.json from lot-samples.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/util.mjs';
import { downloadImages, runClaude, value, readPhotosDeep } from '../src/judge.mjs';
const cfg = loadConfig();
const lots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { PROMPT_FOR_TEST, SCHEMA_FOR_TEST } = await import('../src/judge.mjs');
for (const l of lots) {
  const { dir, n } = await downloadImages(l, 10);
  const t0 = Date.now();
  const ident = await runClaude(cfg, PROMPT_FOR_TEST({ ...l, hint: 'collection being valued for purchase' }), dir, { model: cfg.judgeModel, schema: SCHEMA_FOR_TEST, system: fs.readFileSync(path.join(ROOT, '.claude/skills/mint-deal-check/SKILL.md'), 'utf8'), maxPx: n > 6 ? 900 : 1024 });
  const v1 = await value(cfg, l, ident); const t1 = Date.now();
  const deep = await readPhotosDeep(cfg, l, dir);
  const v2 = await value(cfg, l, { ...ident, cards: deep.cards, sealed: deep.sealed.length ? deep.sealed : ident.sealed, totalCardCount: Math.max(ident.totalCardCount || 0, deep.cardsVisible) }); const t2 = Date.now();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${l.title.slice(0, 70)}  (${n} photos, asking US$${(l.priceCad / 1.37).toFixed(0)})`);
  console.log(`  one call : ${ident.cards.length} cards found, resale C$${v1.resale.toFixed(0)}  [${((t1 - t0) / 1000).toFixed(0)}s]`);
  console.log(`  per photo: ${deep.cards.length} cards found (${deep.cardsVisible} cards visible), resale C$${v2.resale.toFixed(0)}  [${((t2 - t1) / 1000).toFixed(0)}s]`);
  for (const x of [...v2.lines].sort((a, b) => b.marketCad - a.marketCad).slice(0, 8)) console.log(`     ${x.label}  C$${x.marketCad}  (${x.basis.slice(0, 45)})`);
}
process.exit(0);
