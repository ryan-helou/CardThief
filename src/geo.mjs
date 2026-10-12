import fs from 'node:fs';
import path from 'node:path';
import { DATA, UA, log, sleep } from './util.mjs';

// "Repentigny, QC" → km from home. Marketplace's own radius is an account setting
// (shared with Bike Hunt, set to 500 km), so distance is filtered here instead.
// Free geocoding via OpenStreetMap Nominatim (1 req/s), cached forever.
const HOME = { lat: 45.5703, lon: -73.7556 }; // Laval, H7T
const file = path.join(DATA, 'geo.json');
const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
let last = 0;

function km(a, b) {
  const r = x => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export async function distanceKm(place) {
  const key = (place || '').trim().toLowerCase();
  if (!key) return null;
  if (!(key in cache)) {
    await sleep(Math.max(0, 1100 - (Date.now() - last)));
    last = Date.now();
    try {
      const q = new URLSearchParams({ q: `${place}, Canada`, format: 'json', limit: '1' });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': `CardThief/1.0 (personal; ${UA.slice(0, 20)})` } });
      const hit = (await res.json())[0];
      cache[key] = hit ? { lat: +hit.lat, lon: +hit.lon } : null;
      fs.writeFileSync(file, JSON.stringify(cache));
    } catch (e) {
      log('geocode failed', place, e.message);
      return null;
    }
  }
  return cache[key] ? Math.round(km(HOME, cache[key])) : null;
}
