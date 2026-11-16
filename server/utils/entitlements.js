/**
 * entitlements.js - the ONE place that decides what a customer may do.
 *
 *   Online Reading edition  -> online reader only
 *   Digital Companion       -> online reader + Companion downloads + Ask SID (the reader is included from 2026-11-16)
 *   Upgrade                 -> Online is revoked, Companion is granted
 *
 * Entitlements live in the user_entitlements table and are derived from PAID orders (never from anything the browser says).
 * The database enforces the hard invariants (one active entitlement per customer, atomic launch allocation, quota),
 * this module maps orders to those functions and answers permission questions for the API.
 */
const supabase = require("../config/supabaseClient");

const CATALOG_KEY = "marketing-reclassified";
const MARKETING_RECLASSIFIED_PRODUCT_ID = String(process.env.MR_PRODUCT_ID || "04b84648-3609-4b31-9ded-2486bacf1e74").toLowerCase();

/** The central permission matrix. Frontend labels are never consulted. */
const PERMISSIONS = Object.freeze({
  none: Object.freeze({ reader: false, companionDownloads: false, askSid: false }),
  online: Object.freeze({ reader: true, companionDownloads: false, askSid: false }),
  companion: Object.freeze({ reader: true, companionDownloads: true, askSid: true }),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The database column is a uuid: anything else (legacy rows, test fixtures) is stored as "unknown" rather than failing the whole operation. */
const uuidOrNull = (v) => (v && UUID_RE.test(String(v)) ? String(v) : null);
const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const escapeLike = (v) => String(v).replace(/[\\%_]/g, (c) => "\\" + c);

function isRefundedOrder(order) {
  if (!order) return false;
  const rs = String(order.refund_status || "").toLowerCase();
  return String(order.status || "").toLowerCase() === "refunded" || rs === "refunded" || rs === "full";
}
const isPaidOrder = (o) => !!o && (o.status === "paid" || o.status === "successful") && !isRefundedOrder(o);

/** Only orders for the Marketing Reclassified book create entitlements (cart orders may hold other products). */
function isCatalogOrder(order) {
  if (!order) return false;
  const pid = String(order.product_id || "").toLowerCase();
  if (pid === MARKETING_RECLASSIFIED_PRODUCT_ID) return true;
  return String(order.book_name || "").toLowerCase().includes("marketing reclassified");
}

/** online | companion, from the order's own tier; falls back to the legacy price/name heuristics used elsewhere. */
function editionFromOrder(order) {
  if (order.is_upgrade === true) return "companion";
  const tier = String(order.access_tier || order.edition_type || "").toLowerCase();
  if (tier === "online") return "online";
  if (tier === "companion" || tier === "upgrade") return "companion";
  const name = String(order.book_name || "").toLowerCase();
  if (name.includes("companion") || name.includes("upgrade")) return "companion";
  if (name.includes("online")) return "online";
  return Number(order.amount) < 30 ? "online" : "companion";
}

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const e = new Error(`${fn}: ${error.message}`);
    e.code = error.code;
    // The feature tables / functions are not installed yet (code deployed before the migration): callers fall back to the legacy rules.
    e.notMigrated = ["PGRST202", "PGRST205", "42883", "42P01"].includes(String(error.code));
    throw e;
  }
  return data;
}

/** Grants or revokes according to ONE order. Idempotent. Never throws: callers (webhooks) must not fail because of it. */
async function syncOrderEntitlement(order) {
  try {
    if (!order || !order.id) return { ok: false, skipped: "no_order" };
    if (!isCatalogOrder(order)) return { ok: true, skipped: "not_catalog" };
    const email = normalizeEmail(order.email);
    if (!email) return { ok: false, skipped: "no_email" };
    if (isRefundedOrder(order)) {
      const r = await rpc("revoke_entitlement_for_order", { p_order_id: order.id, p_reason: "full_refund" });
      return { ok: true, action: "revoke", ...r };
    }
    if (!isPaidOrder(order)) return { ok: true, skipped: "not_paid" };
    const r = await rpc("grant_entitlement_for_order", {
      p_order_id: order.id,
      p_email: email,
      p_user_id: uuidOrNull(order.user_id),
      p_edition: editionFromOrder(order),
      p_is_upgrade: order.is_upgrade === true,
      p_paid_at: order.created_at || new Date().toISOString(),
      p_catalog: CATALOG_KEY,
    });
    return { ok: true, action: "grant", ...r };
  } catch (err) {
    console.error(`[entitlements] sync failed for order ${order && order.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

const lastEmailSync = new Map();
/** Replays a customer's orders (oldest first). Safe to repeat: every step is idempotent. Throttled to once per 30 s per e-mail. */
async function syncEmailEntitlements(email, { force = false } = {}) {
  const e = normalizeEmail(email);
  if (!e) return { ok: false };
  const now = Date.now();
  if (!force && now - (lastEmailSync.get(e) || 0) < 30000) return { ok: true, throttled: true };
  lastEmailSync.set(e, now);
  if (lastEmailSync.size > 5000) lastEmailSync.clear();
  const { data: orders, error } = await supabase.from("orders").select("*").ilike("email", escapeLike(e)).order("created_at", { ascending: true }).limit(200);
  if (error) {
    console.error("[entitlements] could not read orders:", error.message);
    return { ok: false, error: error.message };
  }
  const results = [];
  for (const o of orders || []) results.push(await syncOrderEntitlement(o));
  return { ok: results.every((r) => r.ok), count: results.length };
}

async function getActiveEntitlement(email) {
  const data = await rpc("get_active_entitlement", { p_email: normalizeEmail(email), p_catalog: CATALOG_KEY });
  return data && data.id ? data : null;
}

/** Defence in depth: the entitlement's source order must still be paid and not refunded, whatever path changed it. */
async function entitlementStillBacked(ent) {
  if (!ent || !ent.order_id) return true;
  const { data: order, error } = await supabase.from("orders").select("id,status,refund_status,email,product_id,book_name").eq("id", ent.order_id).maybeSingle();
  if (error || !order) return true; // never remove access because of a read error or a missing legacy row
  if (isRefundedOrder(order)) {
    await rpc("revoke_entitlement_for_order", { p_order_id: ent.order_id, p_reason: "full_refund" }).catch(() => {});
    return false;
  }
  return true;
}

function describe(ent) {
  const edition = ent ? ent.edition : "none";
  const expired = !!(ent && ent.edition === "companion" && ent.ask_sid_expires_at && new Date(ent.ask_sid_expires_at) <= new Date());
  const perms = { ...PERMISSIONS[edition] };
  if (expired) perms.askSid = false; // downloads stay with the purchase; the 12-month period applies to Ask SID
  return { edition, entitlementId: ent ? ent.id : null, permissions: perms, askSidExpired: expired, askSidExpiresAt: ent ? ent.ask_sid_expires_at || null : null, launchPosition: ent ? ent.launch_position || null : null };
}

/** Full access picture of a verified customer. Falls back to replaying their orders when no entitlement exists yet. */
async function resolveAccess(email) {
  let ent = await getActiveEntitlement(email);
  // An Online Reading customer may have upgraded through any channel (Payhip, PayPal, Stripe): look for it (throttled to once per 30 s).
  if (ent && ent.edition === "online") {
    await syncEmailEntitlements(email);
    ent = await getActiveEntitlement(email);
  }
  if (ent && !(await entitlementStillBacked(ent))) ent = null;
  if (!ent) {
    await syncEmailEntitlements(email);
    ent = await getActiveEntitlement(email);
    if (ent && !(await entitlementStillBacked(ent))) ent = null;
  }
  return describe(ent);
}

/** Gate for Companion file downloads. If the migration is not installed yet the legacy order rules apply unchanged. */
async function checkPermissionForEmail(email, permission) {
  try {
    const access = await resolveAccess(email);
    return { allowed: !!access.permissions[permission], access };
  } catch (err) {
    if (err.notMigrated) return { allowed: true, legacy: true };
    throw err;
  }
}
const checkCompanionDownload = (order) => checkPermissionForEmail(order.email, "companionDownloads");
const checkReaderAccess = (order) => checkPermissionForEmail(order.email, "reader");

const filePathCache = {};
/**
 * The PDF an administrator marked CURRENT for one kind (storage path), or null.
 *   kind "companion_pdf" (default): the Companion Pack, exactly as before.
 *   kind "book_pdf": the download-only book PDF.
 * The database is the source of truth: the older per-server JSON file mapping is only a fallback.
 */
async function getCurrentFilePath(kind = "companion_pdf") {
  const c = filePathCache[kind];
  if (c && Date.now() - c.at < 30000) return c.path;
  let p = null;
  try {
    const { data } = await supabase.from("companion_files").select("storage_path,process_status").eq("catalog_key", CATALOG_KEY).eq("kind", kind).eq("is_current", true).maybeSingle();
    p = data && data.process_status === "indexed" ? data.storage_path : null;
  } catch { p = null; }
  filePathCache[kind] = { at: Date.now(), path: p };
  return p;
}
const getCurrentCompanionPath = () => getCurrentFilePath("companion_pdf");

/** Delivery log shown in the admin dashboard. Identifiers only (event type, provider transaction id), never personal data. Best effort. */
async function recordWebhookEvent({ provider, eventType, transactionId, outcome, httpStatus, detail }) {
  try {
    const key = String(eventType) + ":" + String(transactionId || "-");
    const bump = async () => {
      const { data: ex } = await supabase.from("webhook_events").select("id,attempts").eq("provider", provider).eq("event_key", key).maybeSingle();
      if (!ex) return false;
      await supabase.from("webhook_events").update({ attempts: (ex.attempts || 1) + 1, outcome, http_status: httpStatus || null, detail: detail || {}, last_seen_at: new Date().toISOString() }).eq("id", ex.id);
      return true;
    };
    if (await bump()) return;
    const ins = await supabase.from("webhook_events").insert([{ provider, event_key: key, event_type: String(eventType), outcome, http_status: httpStatus || null, detail: detail || {} }]);
    // Another delivery of the same event wrote its row between our read and our insert (unique key): count this one as a repeat.
    if (ins.error && String(ins.error.code) === "23505") await bump();
  } catch (err) {
    if (!err.notMigrated) console.warn("[entitlements] webhook log failed:", err.message);
  }
}

/** Express middleware: needs req.authUser (requireCustomer). Sets req.access. */
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const access = await resolveAccess(req.authUser.email);
      req.access = access;
      if (!access.permissions[permission]) {
        return res.status(403).json({ error: "Your edition does not include this feature.", code: "not_entitled", edition: access.edition });
      }
      return next();
    } catch (err) {
      console.error("[entitlements] permission check failed:", err.message);
      if (err.notMigrated) return res.status(503).json({ error: "This feature is not available yet.", code: "not_available" });
      return res.status(503).json({ error: "Access could not be verified right now. Please try again." });
    }
  };
}

module.exports = {
  CATALOG_KEY, PERMISSIONS, uuidOrNull, normalizeEmail, escapeLike, isRefundedOrder, isPaidOrder, isCatalogOrder, editionFromOrder,
  syncOrderEntitlement, syncEmailEntitlements, getActiveEntitlement, resolveAccess, requirePermission, getCurrentCompanionPath, getCurrentFilePath, recordWebhookEvent, checkPermissionForEmail, checkCompanionDownload, checkReaderAccess, describe, rpc,
};
