// GET  /api/reviews  -> approved reviews for the site (public fields only)
// POST /api/reviews  -> submit a review (general or verified purchase)
import {
  autoPublishVerified, clean, cleanEmail, clientIp, contentFlags, db, env, fail, hit, ipHash, json,
  limited, linkToken, newId, normRef, overLimit, publicView, readJSON, rebuildIndex, safeEqual, turnstileOk,
} from "../lib/core.mjs";

export const config = { path: "/api/reviews" };

const MIN_FILL_MS = 4000; // humans take longer than this to write a review

export default async (req, context) => {
  if (req.method === "GET") return list();
  if (req.method === "POST") return submit(req, context);
  return fail(405, "method", "Method not allowed.");
};

async function list() {
  let index = await db.meta().get("index/public", { type: "json" });
  if (!index) index = await rebuildIndex();
  return json(200, { ok: true, reviews: index.reviews, turnstileSiteKey: env("TURNSTILE_SITE_KEY") || null }, {
    "cache-control": "public, max-age=0, must-revalidate",
    "netlify-cdn-cache-control": "public, durable, s-maxage=30, stale-while-revalidate=120",
  });
}

async function submit(req, context) {
  let b;
  try { b = await readJSON(req); } catch (e) { return fail(e.status || 400, "bad_request", "That request couldn't be read."); }
  const ip = clientIp(req, context);

  // 1. Bot traps. Bots get a normal-looking reply so they don't learn what tripped them.
  const started = Number(b.startedAt);
  if (clean(b.website, 200) || !started || Date.now() - started < MIN_FILL_MS) {
    return json(200, { ok: true, status: "pending" });
  }

  // 2. Rate limits for visitor reviews. Only saved reviews count, so fixing a typo never locks anyone out.
  //    Buyers are capped by their order instead (one review per piece), so a 5-piece order isn't blocked.
  const wantsVerify = Boolean(b.orderRef || b.token);
  if (!wantsVerify && ((await limited("review-hour", ip, 3, 3600)) || (await limited("review-day", ip, 8, 86400)))) {
    return fail(429, "rate_limited", "You've posted several reviews in a short time. Please try again later.");
  }

  // 3. Human check (Cloudflare Turnstile), when configured.
  if (!(await turnstileOk(b.turnstileToken, ip))) {
    return fail(400, "captcha", "Please complete the quick human check, then post again.");
  }

  // 4. Validate fields.
  const rating = Number(b.rating);
  const review = {
    id: newId(),
    productId: Number.isInteger(b.productId) && b.productId > 0 ? b.productId : null,
    productName: clean(b.productName, 80),
    rating,
    title: clean(b.title, 80),
    body: clean(b.body, 1500),
    name: clean(b.name, 40),
    email: cleanEmail(b.email),
    verified: false,
    orderRef: null,
    status: "pending",
    flags: [],
    createdAt: new Date().toISOString(),
    ipHash: ipHash(ip),
  };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(400, "rating", "Choose a rating from 1 to 5 stones.");
  if (review.body.length < 20) return fail(400, "body", "Your review needs at least 20 characters.");
  if (review.name.length < 2) return fail(400, "name", "Add the name you'd like shown with your review.");
  if (b.email && !review.email) return fail(400, "email", "That email address doesn't look right.");

  // 5. Purchase verification.
  if (wantsVerify) {
    // Separate cap on order lookups, so nobody can guess at order numbers.
    if (await overLimit("verify-hour", ip, 10, 3600)) return fail(429, "rate_limited", "Too many order lookups. Please try again later.");
    const ref = normRef(b.orderRef);
    if (!ref) return fail(400, "order_ref", "Order references look like ES-123456.");
    const order = await db.orders().get(`o/${ref}`, { type: "json" });
    const tokenOk = b.token && linkToken(ref) && safeEqual(b.token, linkToken(ref));
    const emailOk = order && review.email && review.email === order.email;
    if (!order || !(tokenOk || emailOk)) {
      return fail(400, "order_not_found", "We couldn't match that order reference and email. Use the email you ordered with, or post without the Verified Purchase label.", { canPostUnverified: true });
    }
    if (order.status !== "confirmed") {
      return fail(400, "order_not_confirmed", "That order isn't marked as confirmed yet. We confirm orders once the deposit is in. You can post without the label now, or come back once it ships.", { canPostUnverified: true });
    }
    if (review.productId && !order.items.some((i) => i.id === review.productId)) {
      return fail(400, "not_in_order", "That piece isn't part of this order. Pick a piece from the order, or choose “The shop overall”.");
    }
    // One review per item per order. onlyIfNew makes this safe against double-clicks.
    const claim = await db.orders().setJSON(`c/${ref}/${review.productId ?? "shop"}`, { reviewId: review.id, at: review.createdAt }, { onlyIfNew: true });
    if (!claim.modified) return fail(409, "already_reviewed", "This order already has a review for that piece. Thank you!");
    review.verified = true;
    review.orderRef = ref;
    if (!review.email) review.email = order.email;
  }

  // 6. Moderation decision.
  review.flags = contentFlags(`${review.title}\n${review.body}\n${review.name}`);
  if (review.verified && autoPublishVerified() && review.flags.length === 0) {
    review.status = "approved";
    review.approvedAt = review.createdAt;
  }

  try {
    await db.reviews().setJSON(`r/${review.id}`, review);
  } catch (e) {
    if (review.verified) await db.orders().delete(`c/${review.orderRef}/${review.productId ?? "shop"}`);
    throw e;
  }
  if (!review.verified) {
    await hit("review-hour", ip, 3, 3600);
    await hit("review-day", ip, 8, 86400);
  }
  if (review.status === "approved") await rebuildIndex();

  return json(201, {
    ok: true,
    status: review.status,
    review: review.status === "approved" ? publicView(review) : null,
  });
}
