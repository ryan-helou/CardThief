import { fetchJson, log } from './util.mjs';

// Free prices: TCGdex (no key) carries TCGplayer (USD) and Cardmarket (EUR), refreshed daily.
// Raw/ungraded only. Graded slabs fall back to the judge's own estimate.
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const cache = new Map();

let fx = { USD: 1.42, EUR: 1.6, at: 0 };
export async function getFx() {
  if (Date.now() - fx.at < 6 * 3600e3) return fx;
  try {
    const r = await fetchJson('https://api.frankfurter.dev/v1/latest?base=CAD&symbols=USD,EUR');
    fx = { USD: 1 / r.rates.USD, EUR: 1 / r.rates.EUR, at: Date.now() };
  } catch (e) {
    log('fx fetch failed, using last rates', e.message);
  }
  return fx;
}

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// TCG Pocket (digital) sets live in the same catalog; never price against them.
const isPocket = c => /^(A\d|P-A)/.test(c.id) || /\/tcgp\//.test(c.image || '');

async function candidates(name, number) {
  const tries = [];
  if (number) {
    const n = String(number).replace(/^0+/, '') || '0';
    for (const id of new Set([n, n.padStart(3, '0'), String(number)])) tries.push(`localId=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`);
  }
  tries.push(`name=eq:${encodeURIComponent(name)}`);
  for (const q of tries) {
    const key = `list:${q}`;
    if (!cache.has(key)) cache.set(key, await fetchJson(`${TCGDEX}/cards?${q}`).catch(() => []));
    const list = cache.get(key).filter(c => !isPocket(c));
    if (list.length) return list;
  }
  return [];
}

async function card(id) {
  if (!cache.has(id)) cache.set(id, await fetchJson(`${TCGDEX}/cards/${encodeURIComponent(id)}`));
  return cache.get(id);
}

function pickPrice(c, variant, rates) {
  const tp = c.pricing?.tcgplayer || {};
  const order = {
    reverse: ['reverse-holofoil', 'reverseHolofoil'],
    holo: ['holofoil'],
    normal: ['normal'],
    '1st': ['1stEditionHolofoil', '1stEditionNormal'],
  }[variant] || [];
  const keys = [...order, 'holofoil', 'normal', 'reverse-holofoil', 'reverseHolofoil', '1stEditionHolofoil'];
  for (const k of keys) {
    const p = tp[k]?.marketPrice ?? tp[k]?.midPrice;
    if (p) return { cad: p * rates.USD, basis: `TCGplayer ${k} market $${p} USD` };
  }
  const cm = c.pricing?.cardmarket;
  const e = cm?.trend || cm?.avg30 || cm?.avg;
  if (e) return { cad: e * rates.EUR, basis: `Cardmarket trend €${e}` };
  return null;
}

// { name, number, setName, setTotal, variant } → { id, label, cad, basis } | null
export async function priceCard(ident) {
  if (!ident?.name) return null;
  const rates = await getFx();
  try {
    let list = await candidates(ident.name, ident.number);
    if (!list.length) return null;
    // Narrow by set name or by the "/165" denominator when we have them.
    if (list.length > 1 && (ident.setName || ident.setTotal)) {
      const full = await Promise.all(list.slice(0, 12).map(c => card(c.id).catch(() => null)));
      const scored = full.filter(Boolean).map(c => {
        let s = 0;
        if (ident.setName && norm(c.set?.name) === norm(ident.setName)) s += 2;
        else if (ident.setName && norm(c.set?.name).includes(norm(ident.setName))) s += 1;
        if (ident.setTotal && [c.set?.cardCount?.official, c.set?.cardCount?.total].includes(Number(ident.setTotal))) s += 2;
        return { c, s };
      }).sort((a, b) => b.s - a.s);
      if (scored.length) list = [scored[0].c];
    }
    // Several equally good matches (e.g. a name reprinted many times): take the cheapest, to stay conservative.
    const priced = [];
    for (const c of list.slice(0, 6)) {
      const full = await card(c.id).catch(() => null);
      const p = full && pickPrice(full, ident.variant, rates);
      if (p) priced.push({ id: full.id, label: `${full.name} ${full.set?.name} ${full.localId}`, ...p });
    }
    if (!priced.length) return null;
    priced.sort((a, b) => a.cad - b.cad);
    return { ...priced[0], ambiguous: priced.length > 1 };
  } catch (e) {
    log('price lookup failed', ident.name, e.message);
    return null;
  }
}
