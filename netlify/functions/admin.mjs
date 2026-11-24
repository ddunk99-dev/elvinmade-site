// /api/admin -> moderation and order tools for the owner. Requires the ADMIN_PASSWORD env var.
// GET  ?view=reviews            -> every review (all statuses, with private fields)
// GET  ?view=orders             -> every order, newest first
// POST { action, ... }          -> setStatus | deleteReview | confirmOrder | unconfirmOrder |
//                                  addOrder | deleteOrder | reviewLink | rebuild
import {
  allReviews, clean, cleanEmail, clientIp, db, env, fail, hit, json, limited, linkToken, newRef, normRef,
  readJSON, rebuildIndex, reviewLink, safeEqual,
} from "../lib/core.mjs";

export const config = { path: "/api/admin" };

export default async (req, context) => {
  const password = env("ADMIN_PASSWORD");
  if (password.length < 12) return fail(503, "not_configured", "Set ADMIN_PASSWORD (12+ characters) in Netlify first.");

  const ip = clientIp(req, context);
  // Lockout is checked before the password, so a correct guess during a lockout still fails.
  if (await limited("admin-fail", ip, 8, 900)) return fail(429, "locked", "Too many wrong passwords. Wait 15 minutes.");
  const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(given, password)) {
    await hit("admin-fail", ip, 8, 900);
    return fail(401, "unauthorized", "Wrong password.");
  }

  try {
    if (req.method === "GET") {
      const view = new URL(req.url).searchParams.get("view");
      if (view === "reviews") return json(200, { ok: true, reviews: await allReviews() });
      if (view === "orders") return json(200, { ok: true, orders: await allOrders(), linksEnabled: Boolean(env("REVIEW_LINK_SECRET")) });
      return fail(400, "view", "Unknown view.");
    }
    if (req.method !== "POST") return fail(405, "method", "Method not allowed.");
    const b = await readJSON(req, 20000);
    const action = ACTIONS[b.action];
    return action ? await action(b) : fail(400, "action", "Unknown action.");
  } catch (e) {
    return fail(e.status || 500, "error", e.status ? "That request couldn't be read." : "Something went wrong. Try again.");
  }
};

async function allOrders() {
  const store = db.orders();
  const { blobs } = await store.list({ prefix: "o/" });
  const orders = [];
  for (let i = 0; i < blobs.length; i += 20) {
    orders.push(...(await Promise.all(blobs.slice(i, i + 20).map((x) => store.get(x.key, { type: "json" })))));
  }
  return orders.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function getReview(id) {
  if (typeof id !== "string" || !/^[a-z0-9]{6,40}$/.test(id)) return null;
  return db.reviews().get(`r/${id}`, { type: "json" });
}
async function getOrder(ref) {
  const r = normRef(ref);
  return r ? db.orders().get(`o/${r}`, { type: "json" }) : null;
}

const ACTIONS = {
  async setStatus({ id, status }) {
    if (!["approved", "pending", "hidden"].includes(status)) return fail(400, "status", "Unknown status.");
    const r = await getReview(id);
    if (!r) return fail(404, "missing", "Review not found.");
    r.status = status;
    if (status === "approved") r.approvedAt = new Date().toISOString();
    await db.reviews().setJSON(`r/${r.id}`, r);
    await rebuildIndex();
    return json(200, { ok: true, review: r });
  },

  async deleteReview({ id }) {
    const r = await getReview(id);
    if (!r) return fail(404, "missing", "Review not found.");
    await db.reviews().delete(`r/${r.id}`);
    // Free the order's slot so the customer can review that piece again.
    if (r.orderRef) await db.orders().delete(`c/${r.orderRef}/${r.productId ?? "shop"}`);
    await rebuildIndex();
    return json(200, { ok: true });
  },

  async confirmOrder({ ref }) { return setOrderStatus(ref, "confirmed"); },
  async unconfirmOrder({ ref }) { return setOrderStatus(ref, "requested"); },

  async addOrder({ name, email, items }) {
    const e = cleanEmail(email), n = clean(name, 80);
    const list = (Array.isArray(items) ? items : []).slice(0, 40)
      .map((i) => ({ id: Number(i?.id), name: clean(i?.name, 80), qty: 1 }))
      .filter((i) => Number.isInteger(i.id) && i.id >= 0 && i.name);
    if (!e || !n || !list.length) return fail(400, "invalid", "Add a name, a valid email and at least one piece.");
    for (let attempt = 0; attempt < 6; attempt++) {
      const ref = newRef();
      const order = { ref, email: e, name: n, items: list, status: "confirmed", source: "admin", createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString() };
      const res = await db.orders().setJSON(`o/${ref}`, order, { onlyIfNew: true });
      if (res.modified) return json(201, { ok: true, order });
    }
    return fail(503, "busy", "Try again.");
  },

  async deleteOrder({ ref }) {
    const o = await getOrder(ref);
    if (!o) return fail(404, "missing", "Order not found.");
    await db.orders().delete(`o/${o.ref}`);
    return json(200, { ok: true });
  },

  async reviewLink({ ref }) {
    const o = await getOrder(ref);
    if (!o) return fail(404, "missing", "Order not found.");
    if (!linkToken(o.ref)) return fail(503, "not_configured", "Set REVIEW_LINK_SECRET in Netlify to create review links.");
    return json(200, { ok: true, url: reviewLink(o.ref) });
  },

  async rebuild() {
    const index = await rebuildIndex();
    return json(200, { ok: true, count: index.reviews.length });
  },
};

async function setOrderStatus(ref, status) {
  const o = await getOrder(ref);
  if (!o) return fail(404, "missing", "Order not found.");
  o.status = status;
  if (status === "confirmed") o.confirmedAt = new Date().toISOString();
  await db.orders().setJSON(`o/${o.ref}`, o);
  return json(200, { ok: true, order: o });
}
