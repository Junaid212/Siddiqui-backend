/**
 * accessLinks.js — short-lived, order-bound, purpose-bound download / reader links.
 *
 * A signed-in customer asks the API for a link to ONE of their own orders; the link works for a couple of minutes and
 * only for that order and that purpose ("download" or "read"). Nothing reusable is ever put into a list response, so a
 * URL that ends up in a log, a history entry or a shared screenshot is worthless almost immediately.
 *
 * Link format:  base64url(JSON {o: orderId, p: "d"|"r", e: expiryEpochSeconds}) + "." + base64url(HMAC-SHA256)
 *
 * Signing key (first that applies):
 *   1. ACCESS_LINK_SECRET (>= 32 characters) — recommended.
 *   2. A key derived from SUPABASE_SERVICE_ROLE (HMAC, not reversible) — stable across restarts and across processes,
 *      and needs no new environment variable.
 *   3. A random per-process key (warns once): links then only work on the process that issued them.
 */
'use strict';
const crypto = require('crypto');

const TTL_SECONDS = 120;
const PURPOSES = { download: 'd', read: 'r' };
const FROM_CODE = { d: 'download', r: 'read' };

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const explicit = process.env.ACCESS_LINK_SECRET;
  if (explicit && explicit.length >= 32) {
    cachedKey = Buffer.from(explicit, 'utf8');
  } else if (process.env.SUPABASE_SERVICE_ROLE) {
    cachedKey = crypto.createHmac('sha256', 'siddiqui-access-link-v1').update(process.env.SUPABASE_SERVICE_ROLE).digest();
  } else {
    cachedKey = crypto.randomBytes(32);
    console.warn('[accessLinks] No ACCESS_LINK_SECRET or SUPABASE_SERVICE_ROLE: using a random per-process key. Links only work on the issuing process.');
  }
  return cachedKey;
}
function resetKeyCacheForTests() { cachedKey = null; }

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payloadPart) => b64(crypto.createHmac('sha256', getKey()).update(payloadPart).digest());

function signAccess({ orderId, purpose, ttlSeconds = TTL_SECONDS, nowMs = Date.now() }) {
  if (!PURPOSES[purpose]) throw new Error('unknown purpose');
  const payloadPart = b64(JSON.stringify({ o: String(orderId), p: PURPOSES[purpose], e: Math.floor(nowMs / 1000) + ttlSeconds }));
  return `${payloadPart}.${sign(payloadPart)}`;
}

/** Returns { orderId, purpose } for a valid, unexpired link; otherwise null. Never throws. */
function verifyAccess(link, { nowMs = Date.now() } = {}) {
  try {
    if (typeof link !== 'string' || link.length > 600) return null;
    const parts = link.split('.');
    if (parts.length !== 2) return null;
    const expected = Buffer.from(sign(parts[0]));
    const given = Buffer.from(parts[1]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload.o !== 'string' || !FROM_CODE[payload.p]) return null;
    if (!(Number(payload.e) > Math.floor(nowMs / 1000))) return null;
    return { orderId: payload.o, purpose: FROM_CODE[payload.p] };
  } catch {
    return null;
  }
}

module.exports = { signAccess, verifyAccess, TTL_SECONDS, resetKeyCacheForTests };
