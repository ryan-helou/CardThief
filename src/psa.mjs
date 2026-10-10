import { loadConfig, log } from './util.mjs';

// PSA's official cert lookup (free token from psacard.com/publicapi, ~100 calls/day).
// Used only right before a PSA slab alert: does this cert exist, and is it this card at this grade?
export async function checkPsaCert(cert, card, grade) {
  const cfg = loadConfig();
  if (!cfg.psaToken) return { checked: false, note: 'PSA cert not checked (no PSA token yet).' };
  if (!cert) return { checked: false, note: 'No PSA cert number in the listing: ask the seller for it.' };
  try {
    const res = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`, {
      headers: { authorization: `bearer ${cfg.psaToken}` },
    });
    if (res.status === 429) return { checked: false, note: 'PSA lookup limit reached today: check the cert yourself.' };
    if (!res.ok) throw new Error(`${res.status}`);
    const c = (await res.json())?.PSACert;
    if (!c?.CertNumber) return { checked: true, ok: false, note: `PSA cert ${cert} doesn't exist: likely fake.` };
    const psaGrade = String(c.CardGrade || '').match(/(\d+(?:\.\d)?)/)?.[1];
    const wantGrade = String(grade).split(' ')[1];
    const nameWord = String(card.name || '').split(' ')[0].toLowerCase();
    const subject = `${c.Subject || ''} ${c.Variety || ''}`.toLowerCase();
    const gradeOk = psaGrade === wantGrade;
    const nameOk = !nameWord || subject.includes(nameWord);
    const what = `${c.Year || ''} ${c.Subject || ''} #${c.CardNumber || '?'} ${c.CardGrade || ''}`.replace(/\s+/g, ' ').trim();
    return gradeOk && nameOk
      ? { checked: true, ok: true, note: `PSA cert ${cert} verified: ${what}.` }
      : { checked: true, ok: false, note: `PSA cert ${cert} is ${what}, not this listing's card/grade.` };
  } catch (e) {
    log('psa cert lookup failed', cert, e.message);
    return { checked: false, note: 'PSA cert check failed: check it yourself.' };
  }
}

// Cert number from the seller's eBay item specifics, e.g. "Certification Number: 12345678".
export function certFromListing(l) {
  return (l.condition || '').match(/Certification Number:\s*(\d{6,10})/i)?.[1] || (l.description || '').match(/\bcert(?:ification)?\s*(?:#|no\.?|number)?\s*:?\s*(\d{8,10})\b/i)?.[1] || null;
}
