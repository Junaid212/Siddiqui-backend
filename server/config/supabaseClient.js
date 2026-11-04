const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load environment from server/.env, then fallback to root .env (only outside staging)
if (process.env.NODE_ENV !== 'staging') {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  if (!process.env.SUPABASE_URL) {
    require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Known production project reference and hostname to guard against configuration leaks
const KNOWN_PRODUCTION_HOST = 'cneariiepqywvjpmznqn.supabase.co';
const KNOWN_PRODUCTION_REF = 'cneariiepqywvjpmznqn';

// Safe startup validation
if (!supabaseUrl) {
  throw new Error('[supabaseClient] Fatal error: SUPABASE_URL environment variable is missing.');
}

if (!supabaseKey) {
  throw new Error('[supabaseClient] Fatal error: Required Supabase key (SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_ROLE_KEY) is missing.');
}

if (process.env.NODE_ENV === 'staging') {
  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.hostname === KNOWN_PRODUCTION_HOST) {
      throw new Error(`[supabaseClient] Safety violation: NODE_ENV is 'staging' but SUPABASE_URL points to the known production project (${KNOWN_PRODUCTION_HOST}). Aborting startup.`);
    }
  } catch (urlErr) {
    if (urlErr.message.includes('Safety violation')) throw urlErr;
    throw new Error(`[supabaseClient] Fatal error: Invalid SUPABASE_URL (${urlErr.message}). Aborting startup.`);
  }

  // Safety check: ensure staging key does not carry the production project reference
  if (supabaseKey.startsWith('sb_secret_') || supabaseKey.startsWith('sb_')) {
    // Opaque secret key: do not treat as JWT; check for production reference directly
    if (supabaseKey.includes(KNOWN_PRODUCTION_REF)) {
      throw new Error(`[supabaseClient] Safety violation: NODE_ENV is 'staging' but the provided Supabase key belongs to production (${KNOWN_PRODUCTION_REF}). Aborting startup.`);
    }
  } else {
    // Legacy JWT key format: decode payload and inspect project reference
    try {
      const parts = supabaseKey.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload && payload.ref === KNOWN_PRODUCTION_REF) {
          throw new Error(`[supabaseClient] Safety violation: NODE_ENV is 'staging' but the provided Supabase key belongs to production (${KNOWN_PRODUCTION_REF}). Aborting startup.`);
        }
      }
    } catch (jwtErr) {
      if (jwtErr.message.includes('Safety violation')) throw jwtErr;
    }
  }
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
