"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Message, Status } from "@/lib/types";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" });

// Message box (one tap sends from Ryan's Marketplace login via the Mac) + Bought/Sold/Pass.
export function DealControls({
  id,
  status,
  price,
  resale,
  draft,
  message,
  canSend,
}: {
  id: string;
  status: Status;
  price: number;
  resale: number;
  draft?: string;
  message: Message | null;
  canSend: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(message?.text || draft || "");
  const [busy, setBusy] = useState(false);

  async function call(path: string, method: string, body: object) {
    setBusy(true);
    try {
      await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  const setStatus = (s: Status, extra: object = {}) => call(`/api/deals/${encodeURIComponent(id)}`, "PATCH", { status: s, ...extra });

  function askPrice(label: string, fallback: number): number | null {
    const v = window.prompt(label, String(Math.round(fallback)));
    if (v == null) return null;
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const btn = "rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50";
  const sent = message?.state === "sent";
  const queued = message?.state === "queued";

  return (
    <div className="mt-3 space-y-2">
      {status === "new" && draft !== undefined && (
        sent ? (
          <p className="text-sm text-[var(--good)]">✓ Messaged at {time(message!.at)}: &ldquo;{message!.text}&rdquo;</p>
        ) : canSend ? (
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              disabled={queued || busy}
              className="min-w-0 flex-1 resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm"
            />
            <button
              disabled={queued || busy || !text.trim()}
              onClick={() => call(`/api/deals/${encodeURIComponent(id)}/message`, "POST", { text })}
              className={`${btn} bg-[var(--accent)] py-2 text-white dark:text-[var(--ground)]`}
            >
              {queued ? "Sending…" : message?.state === "failed" ? "Retry" : "Send"}
            </button>
          </div>
        ) : (
          <button className={`${btn} bg-[var(--surface-2)]`} onClick={() => navigator.clipboard.writeText(text)}>
            Copy message
          </button>
        )
      )}
      {message?.state === "failed" && <p className="text-xs text-[var(--warn)]">Not sent: {message.error}</p>}

      <div className="flex flex-wrap gap-2">
        {status === "new" && (
          <>
            <button
              disabled={busy}
              className={`${btn} bg-[var(--surface-2)]`}
              onClick={() => {
                const n = askPrice("What did you pay (C$, all-in)?", price);
                if (n != null) setStatus("bought", { boughtFor: n });
              }}
            >
              Bought
            </button>
            <button disabled={busy} className={`${btn} text-[var(--ink-3)]`} onClick={() => setStatus("passed")}>
              Pass
            </button>
          </>
        )}
        {status === "bought" && (
          <button
            disabled={busy}
            className={`${btn} bg-[var(--good)] text-white dark:text-[var(--ground)]`}
            onClick={() => {
              const n = askPrice("What did it sell for, after fees and shipping (C$)?", resale);
              if (n != null) setStatus("sold", { soldFor: n });
            }}
          >
            Sold
          </button>
        )}
        {status !== "new" && (
          <button disabled={busy} className={`${btn} text-[var(--ink-3)]`} onClick={() => setStatus(status === "sold" ? "bought" : "new")}>
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
