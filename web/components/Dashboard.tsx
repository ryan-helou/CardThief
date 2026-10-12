import type { Heartbeat, Slim } from "@/lib/types";

export const money = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}C$${Math.abs(Math.round(n)).toLocaleString("en-CA")}`;

export function ago(iso?: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const SOURCE_NAME: Record<string, string> = { ebay: "eBay", facebook: "Marketplace", kijiji: "Kijiji" };
const sourceName = (s: string) => SOURCE_NAME[s] ?? s;

// ---------- Header: is Mint alive, and what is each source doing ----------
export function StatusHeader({ hb }: { hb: Heartbeat | null }) {
  const quiet = !hb || Date.now() - new Date(hb.at).getTime() > 15 * 60000;
  const src = hb?.sources ?? {};
  const last: Record<string, string | null | undefined> = { ebay: hb?.ebay, facebook: hb?.facebook, kijiji: hb?.kijiji };
  return (
    <section className="rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`relative flex size-2.5 ${quiet ? "" : ""}`}>
            {!quiet && <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--good)] opacity-60" />}
            <span className={`relative inline-flex size-2.5 rounded-full ${quiet ? "bg-[var(--warn)]" : "bg-[var(--good)]"}`} />
          </span>
          <p className="font-semibold">{quiet ? "Mint is offline" : "Mint is hunting"}</p>
        </div>
        <p className="text-xs text-[var(--ink-3)]">{hb ? `checked in ${ago(hb.at)}` : "never checked in"}</p>
      </div>
      {quiet && (
        <p className="mt-2 text-sm text-[var(--warn)]">The Mac may be asleep, closed or offline, so nothing is being watched.</p>
      )}
      <ul className="mt-3 space-y-1.5 text-sm">
        {(["ebay", "facebook", "kijiji"] as const).map((k) => {
          const s = src[k];
          if (!s) return null;
          const paused = k === "facebook" && s.on && s.active === false;
          const state = !s.on ? "off" : paused ? `paused until ${s.hours?.[0]}am` : `last search ${ago(last[k])}`;
          const queued = hb?.queueBySource?.[k];
          return (
            <li key={k} className="flex items-baseline justify-between gap-3">
              <span className={s.on ? "" : "text-[var(--ink-3)]"}>
                {sourceName(k)}
                {k === "ebay" && s.mode ? <span className="text-[var(--ink-3)]"> · {s.mode}</span> : null}
              </span>
              <span className={`text-xs ${!s.on ? "text-[var(--ink-3)]" : paused ? "text-[var(--warn)]" : "text-[var(--ink-2)]"}`}>
                {state}
                {queued ? ` · ${queued} waiting` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {hb?.lastError && !quiet && <p className="mt-2 truncate text-xs text-[var(--ink-3)]" title={hb.lastError}>Last hiccup: {hb.lastError}</p>}
    </section>
  );
}

// ---------- Small stat tiles ----------
export function StatTiles({ hb, deals, profit }: { hb: Heartbeat | null; deals: number; profit: number | null }) {
  const t = hb?.today;
  const tiles = [
    { label: "Seen today", value: t?.found ?? "—" },
    { label: "Checked", value: t?.judged ?? "—" },
    { label: "Open deals", value: deals, accent: deals > 0 },
    { label: "Profit made", value: profit == null ? "—" : money(profit) },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {tiles.map((x) => (
        <div key={x.label} className="rounded-xl bg-[var(--surface)] px-2 py-2.5 text-center ring-1 ring-[var(--rule)]">
          <p className={`text-lg font-semibold num ${x.accent ? "text-[var(--steal)]" : ""}`}>{x.value}</p>
          <p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">{x.label}</p>
        </div>
      ))}
    </div>
  );
}

function Bar({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "good" | "warn" | "ink" }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const color = { accent: "var(--accent)", good: "var(--good)", warn: "var(--warn)", ink: "var(--ink-3)" }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-4">
      <h3 className="font-semibold">{title}</h3>
      {sub && <p className="mt-0.5 text-xs text-[var(--ink-3)]">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

// ---------- Today: how every listing got broken down ----------
export function TodayView({ hb }: { hb: Heartbeat | null }) {
  const t = hb?.today;
  if (!t) return <Empty text="No numbers yet. They appear after the bot's next check-in." />;
  const funnel = [
    { label: "Seen", n: t.found, note: "new listings found by the searches" },
    { label: "Passed the free filters", n: t.judged, note: "price, distance, language, grader…" },
    { label: "Quick AI look", n: (t.stages["2"] ?? 0) + (t.stages["3"] ?? 0), note: "Haiku: title + photo, or slab label" },
    { label: "Full check", n: t.stages["3"] ?? 0, note: "Sonnet reads every photo, or slab cert + photos" },
    { label: "Deals", n: t.deals, note: "met the steal or good bar" },
  ];
  const reasons = Object.entries(t.reasons).sort((a, b) => b[1] - a[1]);
  const maxReason = reasons[0]?.[1] ?? 1;
  const week = hb?.week ?? [];
  const maxWeek = Math.max(1, ...week.map((d) => d.found));
  const b = hb?.budgets;
  return (
    <div className="space-y-3">
      {(hb?.outcomes?.length ?? 0) > 0 && (
        <Card title="What happened to the alerts" sub="Each eBay alert is re-checked every 15 minutes. Real steals sell fast.">
          <ul className="space-y-1.5 text-sm">
            {hb!.outcomes!.slice(0, 8).map((o) => (
              <li key={o.id} className="flex items-baseline justify-between gap-3">
                <a href={o.url} className="min-w-0 truncate">{o.title}</a>
                <span className={`shrink-0 num ${o.status === "sold" ? "text-[var(--good)]" : "text-[var(--ink-3)]"}`}>
                  {o.status === "live" ? "still up" : o.status === "sold" ? `sold in ${o.minutesAfterAlert} min` : o.status === "ended" ? "ended" : "pulled"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Today's funnel" sub="Every listing goes through the cheapest check that can decide it.">
        <ul className="space-y-2.5">
          {funnel.map((f, i) => (
            <li key={f.label}>
              <div className="flex items-baseline justify-between text-sm">
                <span>{f.label}</span>
                <span className="font-semibold num">{f.n.toLocaleString("en-CA")}</span>
              </div>
              <Bar value={f.n} max={t.found} tone={i === funnel.length - 1 ? "good" : "accent"} />
              <p className="mt-0.5 text-[11px] text-[var(--ink-3)]">{f.note}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Why listings were passed" sub="Today, all sources.">
        <ul className="space-y-2">
          {reasons.map(([why, n]) => (
            <li key={why}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{why}</span>
                <span className="shrink-0 text-[var(--ink-2)] num">{n}</span>
              </div>
              <Bar value={n} max={maxReason} tone="ink" />
            </li>
          ))}
        </ul>
      </Card>

      <Card title="By source" sub="Today.">
        <table className="w-full text-sm num">
          <thead className="text-left text-[11px] uppercase tracking-wide text-[var(--ink-3)]">
            <tr><th className="font-medium">Source</th><th className="text-right font-medium">Seen</th><th className="text-right font-medium">Checked</th><th className="text-right font-medium">Deals</th></tr>
          </thead>
          <tbody>
            {Object.entries(t.bySource).map(([k, v]) => (
              <tr key={k} className="border-t border-[var(--rule)]">
                <td className="py-1.5">{sourceName(k)}</td>
                <td className="text-right">{v.found}</td>
                <td className="text-right">{v.judged}</td>
                <td className={`text-right ${v.deals ? "font-semibold text-[var(--steal)]" : ""}`}>{v.deals}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {week.length > 0 && (
        <Card title="Last 7 days" sub="Listings seen per day; deals in red.">
          <div className="flex h-28 items-end gap-1.5">
            {week.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] text-[var(--steal)] num">{d.deals || ""}</span>
                <div className="w-full rounded-t bg-[var(--accent)] opacity-80" style={{ height: `${Math.max(3, (d.found / maxWeek) * 80)}px` }} title={`${d.found} seen, ${d.judged} checked, ${d.deals} deals`} />
                <span className="text-[10px] text-[var(--ink-3)]">{new Date(d.day + "T12:00:00").toLocaleDateString("en-CA", { weekday: "narrow" })}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {b && (
        <Card title="Daily limits" sub="Free tiers; they reset every day.">
          <ul className="space-y-2.5 text-sm">
            <Limit label="Sold-price lookups left" value={b.pptLeft} max={b.pptMax} invert />
            <Limit label="eBay searches used" value={b.ebayCalls} max={b.ebayMax} />
            <Limit label="Marketplace messages sent" value={b.messages} max={b.messagesMax} />
          </ul>
        </Card>
      )}

      {(hb?.recent?.length ?? 0) > 0 && (
        <Card title="Latest checks" sub="What Mint just looked at, newest first.">
          <ul className="divide-y divide-[var(--rule)]">
            {hb!.recent!.map((r, i) => (
              <li key={i} className="py-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 truncate">{r.title}</a>
                  <span className={`shrink-0 text-xs font-medium ${r.tier === "pass" ? "text-[var(--ink-3)]" : "text-[var(--steal)]"}`}>{r.tier === "pass" ? "pass" : r.tier}</span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--ink-3)]">
                  {sourceName(r.source)} · {money(r.price)} · {ago(r.at)} · <span className="text-[var(--ink-2)]">{r.why.slice(0, 110)}</span>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Limit({ label, value, max, invert = false }: { label: string; value: number; max: number; invert?: boolean }) {
  const low = invert ? value / max < 0.2 : value / max > 0.8;
  return (
    <li>
      <div className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className={`num ${low ? "text-[var(--warn)]" : "text-[var(--ink-2)]"}`}>{value.toLocaleString("en-CA")} / {max.toLocaleString("en-CA")}</span>
      </div>
      <Bar value={value} max={max} tone={low ? "warn" : "good"} />
    </li>
  );
}

// ---------- Near misses: the best things Mint passed on, and why ----------
export function NearMisses({ items, soldLinks }: { items: Slim[]; soldLinks: (q: string) => { label: string; href: string }[] }) {
  if (!items.length) return <Empty text="No near misses today yet. These are listings that looked profitable but didn't clear the bar." />;
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-[var(--ink-3)]">The most promising listings Mint passed on today, with its reason. Useful for tuning the rules.</p>
      {items.map((r, i) => (
        <article key={i} className="rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-3">
          <div className="flex gap-3">
            {r.photo && (
              <a href={r.url} target="_blank" rel="noreferrer" className="shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.photo} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-16 rounded-lg bg-[var(--surface-2)] object-cover" />
              </a>
            )}
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline justify-between gap-2 text-xs">
                <span className={`font-semibold ${r.profit >= 0 ? "text-[var(--ink-2)]" : "text-[var(--ink-3)]"}`}>est. {r.profit >= 0 ? "+" : ""}{money(r.profit)}</span>
                <span className="truncate text-[var(--ink-3)]">{sourceName(r.source)} · {ago(r.at)}</span>
              </p>
              <a href={r.url} target="_blank" rel="noreferrer" className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug">{r.title}</a>
              <p className="mt-0.5 text-xs text-[var(--ink-3)] num">{money(r.price)} · stage {r.stage}</p>
            </div>
          </div>
          <p className="mt-2 text-sm text-[var(--ink-2)]"><span className="text-[var(--ink-3)]">Why passed: </span>{r.why}</p>
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs">
            {soldLinks(r.title.slice(0, 70)).map((x) => (
              <a key={x.label} href={x.href} target="_blank" rel="noreferrer" className="font-medium text-[var(--accent)]">{x.label}</a>
            ))}
          </p>
        </article>
      ))}
    </div>
  );
}

// ---------- Rules: how Mint decides, in plain words ----------
export function RulesView({ hb }: { hb: Heartbeat | null }) {
  const r = hb?.rules;
  if (!r) return <Empty text="Rules appear after the bot's next check-in." />;
  const pct = (x: unknown) => `${Math.round(Number(x) * 100)}%`;
  const rows: [string, string][] = [
    ["Steal", `≥ ${money(r.steal?.minProfitCad)} profit and ≥ ${pct(r.steal?.minRoi)} return`],
    ["Good deal", `≥ ${money(r.good?.minProfitCad)} profit and ≥ ${pct(r.good?.minRoi)} return`],
    ["Price range", `${money(Number(r.minPrice))} – ${money(Number(r.maxBuy))}`],
    ["Your cost", `price + shipping to H7T 2W7 + ${pct(r.tax)} tax (eBay); local pickup otherwise`],
    ["Your resale", `eBay sold median − ${pct(r.ebayFee)} fee − ${money(Number(r.resaleShip))} shipping`],
    ["Value source", "real eBay sales only; asking prices are just a filter"],
    ["eBay slabs", `${(r.graders as string[] | undefined)?.join(", ") ?? "—"}, any grade${r.japanese ? ", English + Japanese" : ""}`],
    ["Cheaper than others", `≥ ${pct(r.belowCheapest)} below the cheapest other copy`],
    ["Best Offer", `alert if the deal price is ≥ ${pct(r.offerRatio)} of asking`],
    ["Auctions", `ending within the hour, ≤ ${String(r.maxBids)} bid`],
    ["Marketplace radius", `${String(r.maxDistanceKm)} km from Laval`],
    ["AI limits", `${String(r.haikuPerHour)} quick looks and ${String(r.sonnetPerHour)} full checks an hour`],
  ];
  return (
    <section className="rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-4">
      <h3 className="font-semibold">How Mint decides</h3>
      <dl className="mt-3 divide-y divide-[var(--rule)] text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-3 py-2">
            <dt className="text-[var(--ink-3)]">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-[var(--ink-3)]">Ask Claude to change any of these.</p>
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-[var(--rule)] p-5 text-center text-sm text-[var(--ink-3)]">{text}</p>;
}
