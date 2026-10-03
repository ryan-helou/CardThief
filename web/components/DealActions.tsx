"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Status } from "@/lib/types";

// Bought / Sold / Pass buttons. Prices typed here are what the 4-week test's profit tally uses.
export function DealActions({ id, status, price, ask }: { id: string; status: Status; price: number; ask?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function set(next: Status, extra: { boughtFor?: number; soldFor?: number } = {}) {
    setBusy(true);
    try {
      await fetch(`/api/deals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next, ...extra }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function askPrice(label: string, fallback: number): number | null {
    const v = window.prompt(label, String(Math.round(fallback)));
    if (v == null) return null;
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const btn = "rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-50";
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ask && status === "new" && (
        <button
          className={`${btn} bg-[var(--surface-2)]`}
          onClick={() => navigator.clipboard.writeText(ask).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy question"}
        </button>
      )}
      {status === "new" && (
        <>
          <button
            disabled={busy}
            className={`${btn} bg-[var(--accent)] text-white dark:text-[var(--ground)]`}
            onClick={() => {
              const n = askPrice("What did you pay (C$, all-in)?", price);
              if (n != null) set("bought", { boughtFor: n });
            }}
          >
            Bought
          </button>
          <button disabled={busy} className={`${btn} bg-[var(--surface-2)]`} onClick={() => set("passed")}>
            Pass
          </button>
        </>
      )}
      {status === "bought" && (
        <button
          disabled={busy}
          className={`${btn} bg-[var(--good)] text-white dark:text-[var(--ground)]`}
          onClick={() => {
            const n = askPrice("What did it sell for, after fees and shipping (C$)?", price);
            if (n != null) set("sold", { soldFor: n });
          }}
        >
          Sold
        </button>
      )}
      {status !== "new" && (
        <button disabled={busy} className={`${btn} text-[var(--ink-3)]`} onClick={() => set(status === "sold" ? "bought" : "new")}>
          Undo
        </button>
      )}
    </div>
  );
}
