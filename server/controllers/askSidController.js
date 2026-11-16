/**
 * askSidController.js - Ask SID, the companion to Marketing Reclassified.
 *
 * Access is decided here, on every request, from the customer's entitlement (never from the browser):
 *   Digital Companion (active, not expired, not refunded) -> answers, within 5/day and 100 total (150 for the first 200 launch buyers)
 *   Online Reading                                         -> fixed upgrade message with the configured upgrade link
 *   Anonymous / no purchase                                -> refused (the free public demo was removed)
 * A question is RESERVED before it is answered, COMMITTED only when an answer was delivered, and RELEASED (not charged) when the
 * request is rejected, out of scope, or fails. The legacy controller stays in place as the fallback until the migration and the
 * knowledge index are installed, so deploying this code before them changes nothing for visitors.
 */
const supabase = require("../config/supabaseClient");
const legacy = require("./askSidLegacyController");
const { getVerifiedCustomer } = require("../utils/requireCustomer");
const { getAskSidSettings } = require("../utils/askSidSettingsStore");
const { resolveAccess, rpc, uuidOrNull } = require("../utils/entitlements");
const engine = require("../utils/askSidEngine");

const demoUsageStore = new Map();
const rateLimitStore = new Map();
const MAX_MESSAGE = 600;

const clientIp = (req) => (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.socket?.remoteAddress || "127.0.0.1");

let knowledgeCache = { at: 0, ready: false };
async function knowledgeReady() {
  if (Date.now() - knowledgeCache.at < 60000) return knowledgeCache.ready;
  let ready = false;
  try {
    const { count, error } = await supabase.from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("source", "book");
    ready = !error && (count || 0) > 0;
  } catch { ready = false; }
  knowledgeCache = { at: Date.now(), ready };
  return ready;
}

const upgradePayload = async () => {
  const s = await getAskSidSettings().catch(() => ({}));
  return { upgradeUrl: s.upgradeUrl || "/publications/marketing-reclassified", upgradeCtaText: s.upgradeCtaText || "Upgrade to the Digital Companion Edition" };
};

async function identify(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return { anonymous: true };
  const r = await getVerifiedCustomer(req);
  return r.error ? { error: r.error, status: r.status } : { user: r.user };
}

const DENIAL = {
  daily_limit: (r) => ({ status: 429, message: `You have used today's ${r.daily_limit} questions. Your daily allowance resets at 00:00 UTC.` }),
  total_limit: (r) => ({ status: 403, message: `You have used all ${r.total_limit} questions in your Ask SID allowance.` }),
  expired: () => ({ status: 403, message: "Your 12-month Ask SID access period has ended." }),
  revoked: () => ({ status: 403, message: "Ask SID access is no longer active for this purchase." }),
  no_entitlement: () => ({ status: 403, message: "Ask SID is available with the Digital Companion Edition." }),
};

/** GET /api/ask-sid/config */
// The free demo is removed: whatever the stored settings say, the public configuration reports no demo.
const noDemo = (res) => new Proxy(res, { get: (t, k) => (k === "json" ? (b) => t.json(b && typeof b === "object" ? { ...b, publicDemoEnabled: false, demoAvailable: false, demoQuestionsRemaining: 0, demoQuestionLimit: 0 } : b) : (typeof t[k] === "function" ? t[k].bind(t) : t[k])) });
exports.getPublicConfig = (req, res) => legacy.getPublicConfig(req, noDemo(res));

/** GET /api/ask-sid/access - what the signed-in customer may do, with the remaining allowance. */
exports.checkUserAccess = async (req, res) => {
  try {
    const who = await identify(req);
    if (who.error) return res.status(who.status).json({ error: who.error });
    if (who.anonymous) return legacy.checkUserAccess(req, noDemo(res));
    let access;
    try { access = await resolveAccess(who.user.email); } catch (e) { if (e.notMigrated) return legacy.checkUserAccess(req, noDemo(res)); throw e; }
    const base = await (async () => { const s = await getAskSidSettings().catch(() => ({})); return { askSidEnabled: s.askSidEnabled !== false, ...(await upgradePayload()) }; })();
    res.setHeader("Cache-Control", "private, no-store");
    const hasCompanion = access.edition === "companion";
    let allowance = null;
    if (hasCompanion && access.entitlementId) allowance = await rpc("ask_sid_allowance", { p_entitlement_id: access.entitlementId }).catch(() => null);
    return res.json({
      authenticated: true, userEmail: String(who.user.email).toLowerCase(), edition: access.edition,
      hasCompanionAccess: hasCompanion && access.permissions.askSid, hasOnlineAccess: access.edition === "online",
      accessLevel: hasCompanion ? (access.permissions.askSid ? "full" : "expired") : access.edition === "online" ? "online_only" : "none",
      allowance: allowance ? { dailyLimit: allowance.daily_limit, dailyUsed: allowance.daily_used, dailyRemaining: allowance.daily_remaining, totalLimit: allowance.total_limit, totalUsed: allowance.total_used, totalRemaining: allowance.total_remaining, expiresAt: allowance.expires_at, launchOffer: !!allowance.launch_position } : null,
      ...base,
    });
  } catch (e) {
    console.error("[askSid] access:", e.message);
    return res.status(500).json({ error: "Failed to check access entitlement" });
  }
};

/** POST /api/ask-sid/chat  { message, conversationHistory? } */
exports.askQuestion = async (req, res) => {
  const body = req.body || {};
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Message is required" });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: "message_too_long", message: `Please keep your question under ${MAX_MESSAGE} characters.` });
  const history = Array.isArray(body.conversationHistory) ? body.conversationHistory.slice(-6) : [];

  let usageId = null; let committed = false;
  try {
    const settings = await getAskSidSettings();
    if (settings.askSidEnabled === false) return res.status(503).json({ error: "service_unavailable", message: "Ask SID is temporarily unavailable. Please try again later." });

    const who = await identify(req);
    if (who.error) return res.status(who.status).json({ error: "session", message: who.error });

    // Abuse protection: 30 requests per minute per address.
    const ip = clientIp(req); const win = Math.floor(Date.now() / 60000); const rk = `${ip}_${win}`;
    const rate = (rateLimitStore.get(rk) || 0) + 1; rateLimitStore.set(rk, rate);
    if (rateLimitStore.size > 5000) rateLimitStore.clear();
    if (rate > 30) return res.status(429).json({ error: "rate_limited", message: "You are submitting questions too quickly. Please pause a moment before continuing." });

    let access = null;
    if (who.user) {
      try { access = await resolveAccess(who.user.email); } catch (e) { if (e.notMigrated) return legacy.askQuestion(req, res); throw e; }
    }
    // No free access: a visitor, or a signed-in customer without a purchase, gets no answers (the public demo was removed).
    if (!access || (access.edition !== "online" && access.edition !== "companion")) {
      return res.status(403).json({ error: "unauthorized", message: "Ask SID is available with the Digital Companion Edition. Please sign in with the account you purchased with.", ...(await upgradePayload()) });
    }
    if (!(await knowledgeReady())) return legacy.askQuestion(req, res); // the index is not installed yet: unchanged behaviour

    res.setHeader("Cache-Control", "private, no-store");

    // ---- Online Reading customers: upgrade message only -------------------------------------------------------------
    if (access && access.edition === "online") {
      return res.status(403).json({ error: "upgrade_required", message: engine.ONLINE_UPGRADE_MESSAGE, ...(await upgradePayload()) });
    }

    // ---- Digital Companion customers: quota-controlled answers -------------------------------------------------------
    if (access && access.edition === "companion") {
      const r = await rpc("reserve_ask_sid_question", { p_email: who.user.email, p_user_id: uuidOrNull(who.user.id), p_catalog: "marketing-reclassified" });
      if (!r.allowed) {
        const d = (DENIAL[r.reason] || DENIAL.no_entitlement)(r);
        return res.status(d.status).json({ error: r.reason, message: d.message, ...(r.reason === "daily_limit" ? { resetsAt: r.resets_at } : {}) });
      }
      usageId = r.usage_id;
      const out = await engine.answer({ message, history, includeCompanion: true });
      if (out.outOfScope) {
        await rpc("release_ask_sid_question", { p_usage_id: usageId }).catch(() => {}); usageId = null; // nothing was answered: not charged
        return res.json({ success: true, answer: { text: out.text, sources: [], outOfScope: true }, usage: { charged: false, dailyRemaining: Math.max(r.daily_limit - r.daily_used + 1, 0) } });
      }
      committed = await rpc("commit_ask_sid_question", { p_usage_id: usageId });
      return res.json({ success: true, answer: { text: out.text, sources: out.sources, outOfScope: false }, usage: { charged: true, dailyRemaining: Math.max(r.daily_limit - r.daily_used, 0), totalRemaining: Math.max(r.total_limit - r.total_used, 0), expiresAt: r.expires_at, launchOffer: !!r.launch_position } });
    }

    // ---- No entitlement: the existing public demo, standard book content only -----------------------------------------
    if (settings.publicDemoEnabled === false) {
      return res.status(403).json({ error: "unauthorized", message: "Ask SID is available with the Digital Companion Edition.", ...(await upgradePayload()) });
    }
    const key = String(body.demoSessionId || ip); const limit = Number(settings.demoQuestionLimit || 1); const used = demoUsageStore.get(key) || 0;
    if (used >= limit) return res.status(403).json({ error: "demo_limit_reached", message: "You've reached the current demo limit. Unlock Ask SID with the Digital Companion Edition.", ...(await upgradePayload()) });
    const out = await engine.answer({ message, history, includeCompanion: false });
    if (!out.outOfScope) demoUsageStore.set(key, used + 1); // an out-of-scope reply does not use up the demo question
    if (demoUsageStore.size > 5000) demoUsageStore.clear();
    return res.json({ success: true, isDemo: true, demoQuestionsRemaining: Math.max(0, limit - (demoUsageStore.get(key) || 0)), answer: { text: out.text, sources: out.sources, outOfScope: out.outOfScope } });
  } catch (err) {
    console.error("[askSid] error:", err.message);
    if (usageId && !committed) await rpc("release_ask_sid_question", { p_usage_id: usageId }).catch(() => {}); // a failed answer is never charged
    return res.status(500).json({ error: "internal_error", message: "Something went wrong while processing your question. Please try again." });
  }
};

// Development helper only: in production anyone could otherwise reset the demo allowance.
exports.resetDemo = (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).json({ error: "Not found" });
  demoUsageStore.clear();
  return legacy.resetDemo(req, res);
};
