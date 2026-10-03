import { DealActions } from "@/components/DealActions";
import { Photo } from "@/components/Photo";
import { PushButton } from "@/components/PushButton";
import { listDeals, loadHeartbeat } from "@/lib/db";
import type { DealRow, Heartbeat, Status } from "@/lib/types";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-CA")}`;

function ago(iso?: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function BotStatus({ hb }: { hb: Heartbeat | null }) {
  const quiet = !hb || Date.now() - new Date(hb.at).getTime() > 15 * 60000;
  if (quiet) {
    return (
      <p className="mt-3 rounded-xl bg-[var(--warn-bg)] px-4 py-3 text-sm text-[var(--warn)]">
        {hb ? `The bot last checked in ${ago(hb.at)}.` : "The bot hasn't checked in yet."} The Mac may be asleep, closed, or
        offline, so new listings aren&rsquo;t being watched.
      </p>
    );
  }
  return (
    <p className="mt-2 text-sm text-[var(--ink-2)]">
      <span className="text-[var(--good)]">● Hunting.</span> Kijiji checked {ago(hb.kijiji)}
      {hb.facebook !== undefined && <> · Marketplace {hb.facebook ? `checked ${ago(hb.facebook)}` : "off"}</>}
      {hb.ebay !== undefined && <> · eBay {hb.ebay ? `checked ${ago(hb.ebay)}` : "off"}</>}
      {typeof hb.judgedToday === "number" && <> · {hb.judgedToday} listings judged today</>}
      {hb.queue ? <> · {hb.queue} waiting</> : null}
    </p>
  );
}

function Tally({ rows }: { rows: DealRow[] }) {
  const bought = rows.filter((r) => r.status === "bought" || r.status === "sold");
  if (!bought.length) return null;
  const spent = bought.reduce((a, r) => a + (r.boughtFor ?? r.deal.cost), 0);
  const sold = rows.filter((r) => r.status === "sold");
  const realised = sold.reduce((a, r) => a + (r.soldFor ?? 0) - (r.boughtFor ?? r.deal.cost), 0);
  const holding = rows.filter((r) => r.status === "bought");
  const expected = holding.reduce((a, r) => a + r.deal.resale - (r.boughtFor ?? r.deal.cost), 0);
  return (
    <dl className="mt-4 grid grid-cols-3 gap-2 rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-4 text-center num">
      <div>
        <dt className="text-xs text-[var(--ink-3)]">Spent</dt>
        <dd className="font-semibold">{money(spent)}</dd>
      </div>
      <div>
        <dt className="text-xs text-[var(--ink-3)]">Profit made</dt>
        <dd className={`font-semibold ${realised >= 0 ? "text-[var(--good)]" : "text-[var(--steal)]"}`}>{money(realised)}</dd>
      </div>
      <div>
        <dt className="text-xs text-[var(--ink-3)]">Still to sell</dt>
        <dd className="font-semibold">{money(expected)}</dd>
      </div>
    </dl>
  );
}

function DealCard({ r }: { r: DealRow }) {
  const d = r.deal;
  const quiet = r.status === "passed";
  const steal = d.tier === "steal";
  const lines = [...d.lines].sort((a, b) => b.marketCad - a.marketCad).slice(0, 6);
  return (
    <article id={d.id} className="scroll-mt-4 rounded-2xl border border-[var(--rule)] bg-[var(--surface)] p-4">
      {d.photo && !quiet && <Photo src={d.photo} href={d.url} />}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium">
            <span
              className={`rounded-full px-2 py-0.5 ${steal ? "bg-[var(--steal-bg)] text-[var(--steal)]" : "bg-[var(--good-bg)] text-[var(--good)]"}`}
            >
              {steal ? "Steal" : "Good deal"}
            </span>
            <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 capitalize text-[var(--ink-2)]">{d.source}</span>
            {d.fakeRisk && d.fakeRisk !== "low" && (
              <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-[var(--warn)]">Fake risk: {d.fakeRisk}</span>
            )}
          </p>
          <a href={d.url} className="font-semibold leading-snug underline-offset-2 hover:underline">
            {d.title}
          </a>
          <p className="mt-0.5 text-sm text-[var(--ink-3)]">
            {[d.location, `found ${ago(d.foundAt)}`, d.bids != null ? `${d.bids} bids` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <p className="shrink-0 text-right text-lg font-semibold num">{money(d.price)}</p>
      </div>

      {!quiet && (
        <>
          <dl className="mt-3 grid grid-cols-4 gap-2 text-xs num">
            <div>
              <dt className="text-[var(--ink-3)]">All-in</dt>
              <dd className="font-medium">{money(r.boughtFor ?? d.cost)}</dd>
            </div>
            <div>
              <dt className="text-[var(--ink-3)]">Resale</dt>
              <dd className="font-medium">{money(d.resale)}</dd>
            </div>
            <div>
              <dt className="text-[var(--ink-3)]">Profit</dt>
              <dd className="font-medium text-[var(--good)]">{money(d.profit)}</dd>
            </div>
            <div>
              <dt className="text-[var(--ink-3)]">Return</dt>
              <dd className="font-medium">{Math.round(d.roi * 100)}%</dd>
            </div>
          </dl>

          {d.summary && <p className="mt-3 text-sm text-[var(--ink-2)]">{d.summary}</p>}

          {lines.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {lines.map((x, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    {x.label}
                    <span className="block text-xs text-[var(--ink-3)]">{x.basis}</span>
                  </span>
                  <span className="shrink-0 num">{money(x.marketCad)}</span>
                </li>
              ))}
            </ul>
          )}

          {d.fakeRisk !== "low" && d.fakeReasons && <p className="mt-3 text-sm text-[var(--warn)]">⚠ {d.fakeReasons}</p>}
          {d.hiddenUpside && <p className="mt-2 text-sm text-[var(--ink-2)]">Upside: {d.hiddenUpside}</p>}
          {d.askSeller && r.status === "new" && (
            <p className="mt-3 rounded-xl bg-[var(--surface-2)] p-3 text-sm">
              <span className="block text-xs font-medium uppercase tracking-wide text-[var(--ink-3)]">Ask the seller</span>
              {d.askSeller}
            </p>
          )}
          {r.status === "sold" && (
            <p className="mt-3 text-sm num">
              Paid {money(r.boughtFor)}, sold {money(r.soldFor)} →{" "}
              <span className="font-semibold text-[var(--good)]">{money((r.soldFor ?? 0) - (r.boughtFor ?? 0))}</span>
            </p>
          )}
        </>
      )}
      <DealActions id={d.id} status={r.status} price={r.status === "bought" ? d.resale : d.cost} ask={d.askSeller} />
    </article>
  );
}

const SECTIONS: { status: Status; title: string; blurb: string }[] = [
  { status: "new", title: "New deals", blurb: "Fast ones go in minutes. Message first, then mark Bought or Pass." },
  { status: "bought", title: "Bought", blurb: "Mark Sold with what you netted once it's gone." },
  { status: "sold", title: "Sold", blurb: "" },
  { status: "passed", title: "Passed", blurb: "" },
];

export default async function Home() {
  const [rows, hb] = await Promise.all([listDeals(), loadHeartbeat()]);

  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold">CardThief</h1>
        <p className="mt-1 text-sm text-[var(--ink-3)]">
          Pokémon cards on Marketplace, Kijiji and eBay, priced after eBay fees. Steal = $40+ profit at 50%+ return.
        </p>
        <BotStatus hb={hb} />
        <Tally rows={rows} />
      </header>

      <div className="mb-6">
        <PushButton />
      </div>

      {rows.length === 0 && (
        <p className="rounded-2xl border border-dashed border-[var(--rule)] p-6 text-center text-sm text-[var(--ink-3)]">
          No deals yet. Most listings are fairly priced, so expect a few a week, not a few an hour.
        </p>
      )}

      {SECTIONS.map(({ status, title, blurb }) => {
        const list = rows.filter((r) => r.status === status);
        if (!list.length) return null;
        const body = (
          <div className="mt-3 space-y-3">
            {list.map((r) => (
              <DealCard key={r.deal.id} r={r} />
            ))}
          </div>
        );
        return (
          <section key={status} className="mb-8">
            {status === "passed" || status === "sold" ? (
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-[var(--ink-3)]">
                  {title} ({list.length})
                </summary>
                {body}
              </details>
            ) : (
              <>
                <h2 className="text-sm font-semibold uppercase tracking-wide">
                  {title} <span className="text-[var(--ink-3)]">({list.length})</span>
                </h2>
                {blurb && <p className="text-sm text-[var(--ink-3)]">{blurb}</p>}
                {body}
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
