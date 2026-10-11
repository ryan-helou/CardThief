import { DealControls } from "@/components/DealControls";
import { PushButton } from "@/components/PushButton";
import { listDeals, loadHeartbeat } from "@/lib/db";
import type { DealRow, Status } from "@/lib/types";
import { Empty, NearMisses, RulesView, StatTiles, StatusHeader, TodayView, ago, money } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

// One tap to the real sales for that exact card: asking prices can run 3–4× what cards actually sell for.
const soldLinks = (q: string): { label: string; href: string }[] => [
  { label: "eBay sold", href: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13` },
  { label: "130point", href: `https://130point.com/sales/?search=${encodeURIComponent(q)}` },
  { label: "PriceCharting", href: `https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices` },
];

function SoldCheck({ queries }: { queries: string[] }) {
  if (!queries.length) return null;
  return (
    <div className="mt-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs">
      <p className="font-medium text-[var(--ink-2)]">Check sold prices before buying</p>
      {queries.map((q) => (
        <p key={q} className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[var(--ink-3)]">{q}:</span>
          {soldLinks(q).map((x) => (
            <a key={x.label} href={x.href} target="_blank" rel="noreferrer" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline">
              {x.label}
            </a>
          ))}
        </p>
      ))}
    </div>
  );
}

function DealCard({ r }: { r: DealRow }) {
  const d = r.deal;
  const steal = d.tier === "steal";
  const lines = [...d.lines].sort((a, b) => b.marketCad - a.marketCad).slice(0, 8);
  const quiet = r.status === "passed" || r.status === "sold";
  return (
    <article id={d.id} className="scroll-mt-4 rounded-xl border border-[var(--rule)] bg-[var(--surface)] p-3">
      <div className="flex gap-3">
        {d.photo && !quiet && (
          <a href={d.url} className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={d.photo} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-20 rounded-lg bg-[var(--surface-2)] object-cover" />
          </a>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline justify-between gap-2 text-xs">
            <span className={`shrink-0 whitespace-nowrap font-semibold ${steal ? "text-[var(--steal)]" : "text-[var(--good)]"}`}>
              {steal ? "Steal" : "Deal"} +{money(d.profit)}
            </span>
            <span className="truncate text-[var(--ink-3)]">
              {d.source} · {d.location ? `${d.location} · ` : ""}{ago(d.foundAt)}
            </span>
          </p>
          <a href={d.url} className="mt-0.5 line-clamp-2 font-medium leading-snug">
            {d.title}
          </a>
          <p className="mt-0.5 text-sm text-[var(--ink-2)] num">
            {d.action === "offer" ? (
              <span className="font-medium text-[var(--accent)]">Offer {money(d.offer)} (asking {money(d.price)})</span>
            ) : d.action === "auction" ? (
              <span className="font-medium text-[var(--accent)]">
                Bid up to {money(d.offer)} · now {money(d.price)}, {d.bids ?? 0} bids
                {d.endsAt ? `, ends ${new Date(d.endsAt).toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" })}` : ""}
              </span>
            ) : (
              <>{money(d.cost)} all-in</>
            )}{" "}
            → {money(d.resale)}{" "}
            <span className="text-[var(--ink-3)]">
              · {Math.round(d.roi * 100)}% · {d.source === "ebay" ? `incl. ${money(d.shipping)} ship to H7T + tax` : "local pickup"}
            </span>
          </p>
        </div>
      </div>

      {!quiet && (
        <>
          <SoldCheck queries={d.compsQueries ?? d.lines.slice(0, 3).map((x) => x.label)} />
          {d.fakeRisk && d.fakeRisk !== "low" && (
            <p className="mt-2 text-xs text-[var(--warn)]">⚠ Fake risk {d.fakeRisk}{d.fakeReasons ? `: ${d.fakeReasons}` : ""}</p>
          )}
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-[var(--ink-3)]">{d.summary || "Details"}</summary>
            <ul className="mt-2 space-y-0.5">
              {lines.map((x, i) => (
                <li key={i} className="flex justify-between gap-3 text-[var(--ink-2)]">
                  <span className="min-w-0 truncate" title={x.basis}>{x.label}</span>
                  <span className="shrink-0 num">{money(x.marketCad)}</span>
                </li>
              ))}
            </ul>
            {d.hiddenUpside && <p className="mt-2 text-[var(--ink-2)]">💡 {d.hiddenUpside}</p>}
            {d.askSeller && <p className="mt-1 text-[var(--ink-2)]">❓ {d.askSeller}</p>}
          </details>
          {r.status === "bought" && <p className="mt-2 text-sm num">Paid {money(r.boughtFor)}</p>}
        </>
      )}
      {r.status === "sold" && (
        <p className="mt-1 text-sm num">
          Paid {money(r.boughtFor)}, sold {money(r.soldFor)} →{" "}
          <span className="font-semibold text-[var(--good)]">{money((r.soldFor ?? 0) - (r.boughtFor ?? 0))}</span>
        </p>
      )}
      <DealControls
        id={d.id}
        status={r.status}
        price={d.price}
        resale={d.resale}
        draft={d.draft}
        message={r.message}
        canSend={d.source === "facebook"}
      />
    </article>
  );
}

const SECTIONS: { status: Status; title: string; folded?: boolean }[] = [
  { status: "new", title: "Open deals" },
  { status: "bought", title: "Bought, to resell" },
  { status: "sold", title: "Sold", folded: true },
  { status: "passed", title: "Passed", folded: true },
];

const TABS = [
  { id: "deals", label: "Deals", icon: "M12 2l2.9 6.9L22 10l-5.5 4.7L18.2 22 12 18.3 5.8 22l1.7-7.3L2 10l7.1-1.1z" },
  { id: "misses", label: "Near misses", icon: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v5l3 3" },
  { id: "today", label: "Today", icon: "M4 20V10m6 10V4m6 16v-7m4 7H2" },
  { id: "rules", label: "Rules", icon: "M4 6h16M4 12h16M4 18h10" },
] as const;

function Tally({ rows }: { rows: DealRow[] }) {
  const bought = rows.filter((r) => r.status === "bought" || r.status === "sold");
  if (!bought.length) return null;
  const spent = bought.reduce((a, r) => a + (r.boughtFor ?? r.deal.cost), 0);
  const sold = rows.filter((r) => r.status === "sold");
  const made = sold.reduce((a, r) => a + (r.soldFor ?? 0) - (r.boughtFor ?? r.deal.cost), 0);
  const holding = rows.filter((r) => r.status === "bought");
  const expected = holding.reduce((a, r) => a + r.deal.resale - (r.boughtFor ?? r.deal.cost), 0);
  return (
    <section className="grid grid-cols-3 gap-2 rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-3 text-center num">
      <div><p className="font-semibold">{money(spent)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Spent</p></div>
      <div><p className={`font-semibold ${made >= 0 ? "text-[var(--good)]" : "text-[var(--steal)]"}`}>{money(made)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Profit made</p></div>
      <div><p className="font-semibold">{money(expected)}</p><p className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">Still to sell</p></div>
    </section>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "deals" } = await searchParams;
  const [rows, hb] = await Promise.all([listDeals(), loadHeartbeat()]);
  const open = rows.filter((r) => r.status === "new").length;
  const soldRows = rows.filter((r) => r.status === "sold");
  const profit = soldRows.length ? soldRows.reduce((a, r) => a + (r.soldFor ?? 0) - (r.boughtFor ?? r.deal.cost), 0) : null;

  return (
    <main className="mx-auto max-w-xl px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className="mb-3 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Mint</h1>
        <span className="text-xs text-[var(--ink-3)]">Pokémon deal hunter</span>
      </header>

      <div className="space-y-3">
        <StatusHeader hb={hb} />
        <StatTiles hb={hb} deals={open} profit={profit} />
        <PushButton />
      </div>

      <div className="mt-5">
        {tab === "deals" && (
          <div className="space-y-5">
            <Tally rows={rows} />
            {rows.length === 0 && <Empty text="No deals yet. Steals are rare: expect a few a week, not a few an hour." />}
            {rows.length > 0 && open === 0 && (
              <p className="px-1 text-sm text-[var(--ink-3)]">No open deals right now. See <a className="text-[var(--accent)]" href="?tab=misses">near misses</a> for what came close.</p>
            )}
            {SECTIONS.map(({ status, title, folded }) => {
              const list = rows.filter((r) => r.status === status);
              if (!list.length) return null;
              const body = (
                <div className="mt-2 space-y-2">
                  {list.map((r) => (
                    <DealCard key={r.deal.id} r={r} />
                  ))}
                </div>
              );
              return (
                <section key={status}>
                  {folded ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-semibold text-[var(--ink-3)]">
                        {title} ({list.length})
                      </summary>
                      {body}
                    </details>
                  ) : (
                    <>
                      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">
                        {title} ({list.length})
                      </h2>
                      {body}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {tab === "misses" && <NearMisses items={hb?.nearMisses ?? []} soldLinks={soldLinks} />}
        {tab === "today" && <TodayView hb={hb} />}
        {tab === "rules" && <RulesView hb={hb} />}
      </div>

      {/* Fixed, not sticky: sticky bottom bars strand mid-screen in an installed iOS web app. */}
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-[var(--rule)] bg-[var(--surface)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <li key={t.id}>
                <a href={`?tab=${t.id}`} className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] ${on ? "font-semibold text-[var(--accent)]" : "text-[var(--ink-3)]"}`}>
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d={t.icon} />
                  </svg>
                  {t.label}
                  {t.id === "deals" && open > 0 && <span className="absolute left-1/2 top-1.5 ml-2 rounded-full bg-[var(--steal)] px-1.5 text-[10px] font-semibold text-white">{open}</span>}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </main>
  );
}
