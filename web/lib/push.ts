import webpush, { type WebPushError } from "web-push";
import { allSubs, removeSub, type Sub } from "./db";

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export async function sendPush(p: { title: string; body?: string; tag?: string; url?: string; buyUrl?: string; urgent?: boolean }, only?: Sub) {
  if (!pushConfigured()) return { sent: 0, failed: 0, pruned: 0, skipped: "not-configured" as const };
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:cardthief@localhost",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  // `only` targets one device (the subscribe test), so a stranger on the open page can't buzz Ryan's phone.
  const subs = only ? [only] : await allSubs();
  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0, skipped: "no-devices" as const };
  let sent = 0, failed = 0, pruned = 0;
  const body = JSON.stringify({ title: p.title, body: p.body, tag: p.tag ?? "cardthief", url: p.url ?? "/", buyUrl: p.buyUrl, urgent: p.urgent });
  await Promise.all(
    subs.map(async (s) => {
      try {
        // Deals go stale in minutes; a push that can't arrive within an hour isn't worth delivering.
        await webpush.sendNotification(s, body, { TTL: 3600, urgency: "high" });
        sent++;
      } catch (e) {
        const code = (e as WebPushError).statusCode;
        if (code === 404 || code === 410) {
          await removeSub(s.endpoint);
          pruned++;
        } else failed++;
      }
    }),
  );
  return { sent, failed, pruned };
}
