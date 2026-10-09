import { DealControls } from "@/components/DealControls";
import { PushButton } from "@/components/PushButton";
import { listDeals, loadHeartbeat } from "@/lib/db";
import type { DealRow, Heartbeat, Status } from "@/lib/types";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-CA")}`;

function ago(iso?: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function Status({ hb }: { hb: Heartbeat | null }) {
  if (!hb || Date.now() - new Date(hb.at).getTime() > 15 * 60000) {
    return (
      <p className="rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]">
        Bot quiet {hb ? `for ${ago(hb.at)}` : ""}. The Mac may be asleep or closed.
      </p>
    );
  }
  return (
    <p className="text-sm text-[var(--ink-3)]">
      <span className="text-[var(--good)]">●</span> Hunting
      {hb.queue ? ` · ${hb.queue} to check` : ""}
      {typeof hb.judgedToday === "number" ? ` · ${hb.judgedToday} checked today` : ""}
    </p>
  );
}

function Tally({ rows }: { rows: DealRow[] }) {
  const bought = rows.filter((r) => r.status === "bought" || r.status === "sold");
  if (!bought.length) return null;
  const spent = bought.reduce((a, r) => a + (r.boughtFor ?? r.deal.cost), 0);
  const made = rows
    .filter((r) => r.status === "sold")
    .reduce((a, r) => a + (r.soldFor ?? 0) - (r.boughtFor ?? r.deal.cost), 0);
  return (
    <p className="text-sm num">
      Spent {money(spent)} · Profit <span className={made >= 0 ? "text-[var(--good)]" : "text-[var(--steal)]"}>{money(made)}</span>
    </p>
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
            {money(d.price)} → {money(d.resale)} <span className="text-[var(--ink-3)]">· {Math.round(d.roi * 100)}% return</span>
          </p>
        </div>
      </div>

      {!quiet && (
        <>
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
  { status: "new", title: "Deals" },
  { status: "bought", title: "Bought" },
  { status: "sold", title: "Sold", folded: true },
  { status: "passed", title: "Passed", folded: true },
];

export default async function Home() {
  const [rows, hb] = await Promise.all([listDeals(), loadHeartbeat()]);

  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className="mb-4 space-y-1.5">
        <h1 className="text-xl font-semibold">Mint</h1>
        <Status hb={hb} />
        <Tally rows={rows} />
        <PushButton />
      </header>

      {rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-[var(--rule)] p-5 text-center text-sm text-[var(--ink-3)]">
          No deals yet. Expect a few a week.
        </p>
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
          <section key={status} className="mb-6">
            {folded ? (
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-[var(--ink-3)]">
                  {title} ({list.length})
                </summary>
                {body}
              </details>
            ) : (
              <>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">
                  {title} ({list.length})
                </h2>
                {body}
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
