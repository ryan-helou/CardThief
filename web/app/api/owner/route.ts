import { OWNER_COOKIE, ownerKey, safeEqual } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Ryan opens /api/owner?key=… once on his phone; that device then sees sellers' contact details.
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!process.env.AGENT_TOKEN || !safeEqual(key, ownerKey())) return new Response("Not authorized", { status: 401 });
  return new Response(null, {
    status: 303,
    headers: { location: "/?tab=quote", "set-cookie": `${OWNER_COOKIE}=${ownerKey()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` },
  });
}
