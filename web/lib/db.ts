import { Pool } from "pg";
import type { Deal, DealRow, Heartbeat, Status } from "./types";

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
         CREATE TABLE IF NOT EXISTS heartbeat (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
         CREATE TABLE IF NOT EXISTS push_subs (endpoint text PRIMARY KEY, keys jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`,
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

type Raw = { data: Deal; status: Status; bought_for: string | null; sold_for: string | null; updated_at: Date };
const toRow = (r: Raw): DealRow => ({
  deal: r.data,
  status: r.status,
  boughtFor: r.bought_for == null ? null : Number(r.bought_for),
  soldFor: r.sold_for == null ? null : Number(r.sold_for),
  updatedAt: r.updated_at.toISOString(),
});

export async function listDeals(): Promise<DealRow[]> {
  const rows = await q<Raw>("SELECT data, status, bought_for, sold_for, updated_at FROM deals ORDER BY created_at DESC LIMIT 300");
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
