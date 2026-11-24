// POST /api/orders -> records an order request from checkout and returns its reference (ES-123456).
// Orders start as "requested". The owner marks them "confirmed" in the admin page once the deposit is in;
// only confirmed orders can leave a Verified Purchase review.
import { clean, cleanEmail, clientIp, db, fail, json, newRef, overLimit, readJSON } from "../lib/core.mjs";

export const config = { path: "/api/orders" };

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "method", "Method not allowed.");
  let b;
  try { b = await readJSON(req, 20000); } catch (e) { return fail(e.status || 400, "bad_request", "That request couldn't be read."); }

  const ip = clientIp(req, context);
  if (await overLimit("order-hour", ip, 10, 3600)) return fail(429, "rate_limited", "Too many order requests. Please try again later.");

  const email = cleanEmail(b.email);
  const name = clean(b.name, 80);
  const items = (Array.isArray(b.items) ? b.items : [])
    .slice(0, 40)
    .map((i) => ({ id: Number(i?.id), name: clean(i?.name, 80), qty: Math.min(Math.max(Number(i?.qty) || 1, 1), 20) }))
    .filter((i) => Number.isInteger(i.id) && i.id >= 0 && i.name);
  if (!email || !name || !items.length) return fail(400, "invalid", "Order details are incomplete.");

  const record = { email, name, items, status: "requested", source: "checkout", createdAt: new Date().toISOString() };
  const store = db.orders();
  for (let attempt = 0; attempt < 6; attempt++) {
    const ref = newRef();
    const res = await store.setJSON(`o/${ref}`, { ref, ...record }, { onlyIfNew: true });
    if (res.modified) return json(201, { ok: true, ref });
  }
  return fail(503, "busy", "Couldn't create an order reference. Please try again.");
};
