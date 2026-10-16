import { Pool } from "pg";
import type { Deal, DealRow, Heartbeat, Message, Status } from "./types";

// Three tables: deals (one row per alerted listing, plus what Ryan did with it),
// the bot's heartbeat, and push subscriptions.

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

function db(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url, max: 3 });
  }
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS deals (
           id text PRIMARY KEY,
           data jsonb NOT NULL,
           status text NOT NULL DEFAULT 'new',
           bought_for numeric,
           sold_for numeric,
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now());
         ALTER TABLE deals ADD COLUMN IF NOT EXISTS message jsonb;
         CREATE TABLE IF NOT EXISTS heartbeat (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
         CREATE TABLE IF NOT EXISTS push_subs (endpoint text PRIMARY KEY, keys jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
         CREATE TABLE IF NOT EXISTS quotes (id serial PRIMARY KEY, note text, asking numeric, photos jsonb, status text NOT NULL DEFAULT 'pending', result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
         ALTER TABLE quotes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ryan';
         ALTER TABLE quotes ADD COLUMN IF NOT EXISTS contact jsonb;
         ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lead text NOT NULL DEFAULT 'new';
         ALTER TABLE quotes ADD COLUMN IF NOT EXISTS paid numeric;`,
      )
      .then(() => undefined);
  }
  return pool;
}

async function q<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const p = db();
  await ready;
  return (await p.query(sql, params)).rows as T[];
}

// Returns true when the deal is new (so the caller pushes it once, not on every re-send).
export async function upsertDeal(d: Deal): Promise<boolean> {
  const rows = await q<{ inserted: boolean }>(
    `INSERT INTO deals (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [d.id, JSON.stringify(d)],
  );
  return rows[0]?.inserted ?? false;
}

type Raw = { data: Deal; message: Message | null; status: Status; bought_for: string | null; sold_for: string | null; updated_at: Date };
const toRow = (r: Raw): DealRow => ({
  deal: r.data,
  message: r.message,
  status: r.status,
  boughtFor: r.bought_for == null ? null : Number(r.bought_for),
  soldFor: r.sold_for == null ? null : Number(r.sold_for),
  updatedAt: r.updated_at.toISOString(),
});

export async function listDeals(): Promise<DealRow[]> {
  const rows = await q<Raw>("SELECT data, message, status, bought_for, sold_for, updated_at FROM deals ORDER BY created_at DESC LIMIT 300");
  return rows.map(toRow);
}

export async function setStatus(id: string, status: Status, boughtFor?: number | null, soldFor?: number | null) {
  await q(
    `UPDATE deals SET status = $2,
       bought_for = COALESCE($3, bought_for),
       sold_for = COALESCE($4, sold_for),
       updated_at = now()
     WHERE id = $1`,
    [id, status, boughtFor ?? null, soldFor ?? null],
  );
}

export async function saveHeartbeat(h: Heartbeat) {
  await q(
    "INSERT INTO heartbeat (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()",
    [JSON.stringify(h)],
  );
}

export async function loadHeartbeat(): Promise<Heartbeat | null> {
  const rows = await q<{ data: Heartbeat }>("SELECT data FROM heartbeat WHERE id = 1");
  return rows[0]?.data ?? null;
}

export interface Sub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function allSubs(): Promise<Sub[]> {
  return q<Sub>("SELECT endpoint, keys FROM push_subs");
}

export async function saveSub(s: Sub): Promise<void> {
  await q(
    "INSERT INTO push_subs (endpoint, keys) VALUES ($1, $2) ON CONFLICT (endpoint) DO UPDATE SET keys = $2",
    [s.endpoint, JSON.stringify(s.keys)],
  );
}

export async function removeSub(endpoint: string): Promise<void> {
  await q("DELETE FROM push_subs WHERE endpoint = $1", [endpoint]);
}

export async function deleteDeal(id: string): Promise<void> {
  await q("DELETE FROM deals WHERE id = $1", [id]);
}

export async function queueMessage(id: string, text: string) {
  const m: Message = { text, state: "queued", at: new Date().toISOString() };
  await q("UPDATE deals SET message = $2, updated_at = now() WHERE id = $1", [id, JSON.stringify(m)]);
}

export async function outbox(): Promise<{ id: string; url: string; text: string }[]> {
  return q(
    "SELECT id, data->>'url' AS url, message->>'text' AS text FROM deals WHERE message->>'state' = 'queued' ORDER BY updated_at",
  );
}

export async function setMessageResult(id: string, state: "sent" | "failed", error?: string) {
  await q(
    `UPDATE deals SET message = message || jsonb_build_object('state', $2::text, 'at', now(), 'error', $3::text), updated_at = now() WHERE id = $1`,
    [id, state, error ?? null],
  );
}

// ---------- Quotes: Ryan photographs a binder/collection, the Mac values it ----------
export type SellerContact = { name: string; contact: string; city: string; lang: "fr" | "en" };
export type Quote = { id: number; note: string | null; asking: number | null; status: "pending" | "working" | "done" | "failed"; result: QuoteResult | null; createdAt: string; photoCount: number; source: "ryan" | "seller"; contact: SellerContact | null; lead: Lead; paid: number | null };
export type Lead = "new" | "contacted" | "offered" | "bought" | "passed";
export type QuoteResult = {
  summary: string; totalCards: number | null; photosRead?: number; resale: number; marketTotal: number; offerSteal: number; offerGood: number;
  profitAtAsking: number | null; lines: { label: string; marketCad: number; netCad: number; basis: string }[]; askSeller: string; fakeRisk: string; error?: string;
};

export async function createQuote(note: string | null, asking: number | null, photos: string[], source: "ryan" | "seller" = "ryan", contact: SellerContact | null = null): Promise<number> {
  const rows = await q<{ id: number }>(`INSERT INTO quotes (note, asking, photos, source, contact) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [note, asking, JSON.stringify(photos), source, contact ? JSON.stringify(contact) : null]);
  return rows[0].id;
}
export async function quotesToday(source: "ryan" | "seller" = "ryan"): Promise<number> {
  const rows = await q<{ n: string }>(`SELECT count(*) AS n FROM quotes WHERE source = $1 AND created_at > now() - interval '24 hours'`, [source]);
  return Number(rows[0]?.n ?? 0);
}
// Sellers' contact details only go to Ryan's own device (owner cookie); the app itself is open.
export async function listQuotes(owner: boolean): Promise<Quote[]> {
  const rows = await q<{ id: number; note: string | null; asking: string | null; status: Quote["status"]; result: QuoteResult | null; created_at: Date; n: number; source: Quote["source"]; contact: SellerContact | null; lead: Lead; paid: string | null }>(
    `SELECT id, note, asking, status, result, created_at, source, contact, lead, paid, COALESCE(jsonb_array_length(photos), (result->>'photoCount')::int, 0) AS n FROM quotes ORDER BY id DESC LIMIT 25`,
  );
  return rows
    .filter((r) => owner || r.source === "ryan")
    .map((r) => ({ id: r.id, note: r.note, asking: r.asking == null ? null : Number(r.asking), status: r.status, result: r.result, createdAt: r.created_at.toISOString(), photoCount: r.n, source: r.source, contact: owner ? r.contact : null, lead: r.lead, paid: r.paid == null ? null : Number(r.paid) }));
}
// The Mac claims pending quotes one at a time.
export async function claimQuote(): Promise<{ id: number; note: string | null; asking: number | null; photos: string[] } | null> {
  const rows = await q<{ id: number; note: string | null; asking: string | null; photos: string[] }>(
    `UPDATE quotes SET status = 'working', updated_at = now() WHERE id = (
       SELECT id FROM quotes WHERE status = 'pending' OR (status = 'working' AND updated_at < now() - interval '15 minutes') ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, note, asking, photos`,
  );
  const r = rows[0];
  return r ? { id: r.id, note: r.note, asking: r.asking == null ? null : Number(r.asking), photos: r.photos || [] } : null;
}
// Photos are dropped once valued: they were only needed for the one read.
export async function finishQuote(id: number, result: QuoteResult, failed: boolean): Promise<{ source: string; contact: SellerContact | null; asking: number | null } | null> {
  const rows = await q<{ source: string; contact: SellerContact | null; asking: string | null }>(
    `UPDATE quotes SET status = $2, result = $3, photos = NULL, updated_at = now() WHERE id = $1 RETURNING source, contact, asking`,
    [id, failed ? "failed" : "done", JSON.stringify(result)],
  );
  const r = rows[0];
  return r ? { source: r.source, contact: r.contact, asking: r.asking == null ? null : Number(r.asking) } : null;
}
export async function deleteQuote(id: number) {
  await q(`DELETE FROM quotes WHERE id = $1`, [id]);
}
export async function markGone(id: string, why: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `UPDATE deals SET status = 'passed', data = data || jsonb_build_object('gone', $2::text), updated_at = now() WHERE id = $1 AND status = 'new' RETURNING id`,
    [id, why],
  );
  return rows.length > 0;
}
export async function setLead(id: number, lead: Lead, paid: number | null) {
  await q(`UPDATE quotes SET lead = $2, paid = COALESCE($3, paid), updated_at = now() WHERE id = $1`, [id, lead, paid]);
}
