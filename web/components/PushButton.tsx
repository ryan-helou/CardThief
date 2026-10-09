"use client";
import { useEffect, useState } from "react";

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "checking" | "unsupported" | "install-first" | "off" | "on" | "working" | "error";

export function PushButton() {
  const [state, setState] = useState<State>("checking");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        // iOS only exposes push to a web app added to the Home Screen.
        const ios = /iPhone|iPad/.test(navigator.userAgent);
        setState(ios ? "install-first" : "unsupported");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("error"));
  }, []);

  async function enable() {
    setState("working");
    try {
      const { publicKey } = await fetch("/api/push").then((r) => r.json());
      if (!publicKey) throw new Error("Push isn't configured on the server yet.");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications were not allowed.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error("The server didn't save this device.");
      setState("on");
      setMsg("You should get a test notification now.");
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
    }
  }

  if (state === "checking" || state === "on") {
    return state === "on" && msg ? <p className="text-sm text-[var(--good)]">{msg}</p> : null;
  }
  if (state === "install-first") {
    return (
      <p className="rounded-xl bg-[var(--warn-bg)] px-4 py-3 text-sm text-[var(--warn)]">
        To get alerts, tap Share, then Add to Home Screen, and open Mint from there.
      </p>
    );
  }
  if (state === "unsupported") return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={enable}
        disabled={state === "working"}
        className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-medium text-white disabled:opacity-60 dark:text-[var(--ground)]"
      >
        {state === "working" ? "Turning on…" : "Turn on deal alerts"}
      </button>
      {msg && <p className="text-sm text-[var(--warn)]">{msg}</p>}
    </div>
  );
}
