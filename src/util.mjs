import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const localPath = path.join(ROOT, 'config.local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  return { ...base, ...local };
}

export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(DATA, 'cardthief.log'), line + '\n');
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const jitter = (ms, frac = 0.25) => ms * (1 - frac + Math.random() * 2 * frac);

export async function fetchText(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'user-agent': UA, 'accept-language': 'fr-CA,en;q=0.8', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${url} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Small JSON-file store: seen listing ids, so each listing is judged once.
export class Seen {
  constructor(name) {
    this.file = path.join(DATA, `${name}.json`);
    this.map = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  has(id) { return id in this.map; }
  add(id) { this.map[id] = Date.now(); }
  save() {
    const cutoff = Date.now() - 60 * 864e5; // forget after 60 days
    for (const [k, t] of Object.entries(this.map)) if (t < cutoff) delete this.map[k];
    fs.writeFileSync(this.file, JSON.stringify(this.map));
  }
  get size() { return Object.keys(this.map).length; }
}

export function appendJsonl(name, obj) {
  fs.appendFileSync(path.join(DATA, `${name}.jsonl`), JSON.stringify(obj) + '\n');
}
