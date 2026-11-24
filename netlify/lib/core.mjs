// Shared helpers for the EchElon Stones reviews feature.
// Runs inside Netlify Functions (Node 20+). Data lives in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/* ---------- config ---------- */
export const env = (k, d = "") => {
  const v = globalThis.Netlify?.env?.get?.(k) ?? process.env[k];
  return v === undefined || v === null || v === "" ? d : String(v);
};
export const SITE_URL = () => env("SITE_URL", env("URL", "https://elvinmade.com")).replace(/\/+$/, "");
export const autoPublishVerified = () => env("AUTO_PUBLISH_VERIFIED", "true").toLowerCase() !== "false";

/* ---------- storage ---------- */
// Tests can swap in in-memory stores through globalThis.__ES_STORES__.
const open = (name) => globalThis.__ES_STORES__?.[name] ?? getStore({ name, consistency: "strong" });
export const db = {
  reviews: () => open("es-reviews"), // r/<id>  -> full review record (source of truth)
  orders: () => open("es-orders"),   // o/<REF> -> order record; c/<REF>/<item> -> one-review-per-item claim
  meta: () => open("es-meta"),       // index/public -> cached list of approved public reviews
  limits: () => open("es-limits"),   // rl/<bucket>/<iphash> -> recent hit timestamps
};

/* ---------- http ---------- */
export const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
export const fail = (status, code, message, extra = {}) => json(status, { ok: false, code, message, ...extra });

export async function readJSON(req, maxBytes = 12000) {
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error("too_large"), { status: 413 });
  try { return JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("bad_json"), { status: 400 }); }
}

export const clientIp = (req, context) =>
  context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";

export const ipHash = (ip) =>
  createHash("sha256").update(`${env("REVIEW_LINK_SECRET", "es")}|${ip}`).digest("hex").slice(0, 24);

/* ---------- text cleaning ---------- */
export function clean(v, max) {
  if (typeof v !== "string") return "";
  return v
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}
export const cleanEmail = (v) => {
  const e = clean(v, 120).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : "";
};
export const normRef = (v) => {
  const m = String(v || "").toUpperCase().replace(/\s+/g, "").match(/^(?:ES-?)?(\d{6})$/);
  return m ? `ES-${m[1]}` : "";
};

// Signals that a review needs a human look even if it would otherwise auto-publish.
export function contentFlags(text) {
  const flags = [];
  const urls = (text.match(/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ru|cn|xyz|top|shop|info|biz)\b)/gi) || []).length;
  if (urls) flags.push("link");
  if (/<[a-z/][^>]*>/i.test(text)) flags.push("html");
  const letters = text.replace(/[^a-z]/gi, "");
  if (letters.length > 25 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) flags.push("shouting");
  if (/(.)\1{7,}/.test(text)) flags.push("repeated-chars");
  if (/\b(viagra|casino|crypto|bitcoin|loan|porn|xxx|escort|seo services|backlinks?|telegram|whatsapp)\b/i.test(text)) flags.push("spam-words");
  return flags;
}

/* ---------- ids & signatures ---------- */
export const newId = () => `${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
export const newRef = () => `ES-${randomInt(100000, 1000000)}`;

export function linkToken(ref) {
  const secret = env("REVIEW_LINK_SECRET");
  if (!secret) return "";
  return createHmac("sha256", secret).update(`review-link:${ref}`).digest("base64url").slice(0, 32);
}
export function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
}
export const reviewLink = (ref) => `${SITE_URL()}/?review=${encodeURIComponent(`${ref}.${linkToken(ref)}`)}#reviews`;

/* ---------- rate limiting ---------- */
// Sliding window per (bucket, ip). limited() only reads; hit() records one event.
const rlKey = (bucket, ip) => `rl/${bucket}/${ipHash(ip)}`;
async function recent(bucket, ip, windowSec) {
  const now = Date.now();
  return ((await db.limits().get(rlKey(bucket, ip), { type: "json" })) || []).filter((t) => now - t < windowSec * 1000);
}
export async function limited(bucket, ip, limit, windowSec) {
  return (await recent(bucket, ip, windowSec)).length >= limit;
}
export async function hit(bucket, ip, limit, windowSec) {
  const hits = await recent(bucket, ip, windowSec);
  hits.push(Date.now());
  await db.limits().setJSON(rlKey(bucket, ip), hits.slice(-Math.max(limit, 1)));
}
// Check and record in one step (for endpoints where every call counts).
export async function overLimit(bucket, ip, limit, windowSec) {
  if (await limited(bucket, ip, limit, windowSec)) return true;
  await hit(bucket, ip, limit, windowSec);
  return false;
}

/* ---------- Cloudflare Turnstile ---------- */
export async function turnstileOk(token, ip) {
  const secret = env("TURNSTILE_SECRET_KEY");
  if (!secret) return true; // not configured: other layers still apply
  if (!token || typeof token !== "string" || token.length > 2048) return false;
  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (ip) body.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const d = await r.json();
    return d.success === true;
  } catch {
    return false;
  }
}

/* ---------- public review index ---------- */
export const publicView = (r) => ({
  id: r.id,
  productId: r.productId,
  rating: r.rating,
  title: r.title,
  body: r.body,
  name: r.name,
  verified: r.verified,
  createdAt: r.createdAt,
});

async function mapLimit(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

export async function allReviews() {
  const store = db.reviews();
  const { blobs } = await store.list({ prefix: "r/" });
  const rows = await mapLimit(blobs, 20, (b) => store.get(b.key, { type: "json" }));
  return rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Rebuilds the cached list from the individual review records, so it always self-heals.
export async function rebuildIndex() {
  const approved = (await allReviews()).filter((r) => r.status === "approved").map(publicView);
  const index = { updatedAt: new Date().toISOString(), reviews: approved };
  await db.meta().setJSON("index/public", index);
  return index;
}
