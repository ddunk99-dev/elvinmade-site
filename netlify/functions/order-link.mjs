// GET /api/order-link?r=ES-123456&t=<token>
// Checks a personal review link (sent by the owner) and returns the pieces in that order,
// so the review form can show them. Returns no email, address, or prices.
import { clientIp, db, fail, json, linkToken, normRef, overLimit, safeEqual } from "../lib/core.mjs";

export const config = { path: "/api/order-link" };

export default async (req, context) => {
  if (req.method !== "GET") return fail(405, "method", "Method not allowed.");
  if (await overLimit("link-check", clientIp(req, context), 30, 3600)) return fail(429, "rate_limited", "Please try again later.");

  const url = new URL(req.url);
  const ref = normRef(url.searchParams.get("r"));
  const token = url.searchParams.get("t") || "";
  const expected = ref ? linkToken(ref) : "";
  if (!ref || !expected || !safeEqual(token, expected)) return fail(404, "invalid_link", "This review link isn't valid.");

  const order = await db.orders().get(`o/${ref}`, { type: "json" });
  if (!order) return fail(404, "invalid_link", "This review link isn't valid.");

  return json(200, {
    ok: true,
    ref,
    confirmed: order.status === "confirmed",
    firstName: (order.name || "").split(" ")[0],
    items: order.items.map((i) => ({ id: i.id, name: i.name })),
  });
};
