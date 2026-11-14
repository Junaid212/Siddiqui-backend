/**
 * requireCustomer.js — identifies the signed-in customer from a Supabase access token.
 *
 * Order history and ownership data are personal: they must only be returned to the person who owns
 * them, never to whoever types an email address. The caller's identity is taken from the verified
 * Supabase session (never from a query string or request body) and the e-mail on that session must be
 * confirmed (Google sign-in or a confirmed e-mail account; production has e-mail auto-confirm OFF).
 */
const supabase = require("../config/supabaseClient");

async function getVerifiedCustomer(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return { status: 401, error: "Please sign in to view your orders." };
  }
  const token = header.slice(7).trim();
  if (!token) {
    return { status: 401, error: "Please sign in to view your orders." };
  }

  let user = null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data && data.user) user = data.user;
  } catch (e) {
    console.warn("[requireCustomer] token verification error:", e.message);
  }

  if (!user) {
    return { status: 401, error: "Your session has expired. Please sign in again." };
  }
  if (!user.email || !(user.email_confirmed_at || user.confirmed_at)) {
    return { status: 403, error: "Please confirm your email address to view your orders." };
  }
  return { user };
}

/** Express middleware: 401/403 unless a verified customer is present; sets req.authUser. */
const requireCustomer = async (req, res, next) => {
  try {
    const result = await getVerifiedCustomer(req);
    if (result.error) return res.status(result.status).json({ error: result.error });
    req.authUser = result.user;
    return next();
  } catch (err) {
    console.error("[requireCustomer] Error:", err);
    return res.status(500).json({ error: "Authentication failed." });
  }
};

/** Escapes LIKE wildcards so an e-mail is matched literally (a '%' must never widen a lookup). */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => "\\" + c);
}

module.exports = { requireCustomer, getVerifiedCustomer, escapeLike };
