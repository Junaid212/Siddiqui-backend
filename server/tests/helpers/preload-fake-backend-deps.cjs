/**
 * Test-only preload (node -r). Replaces the customer API's Supabase client, e-mail helper and nodemailer with
 * in-memory fakes so the REAL server.js can be started and exercised over HTTP with no network, database or
 * mail account. Nothing here is loaded in production.
 *
 * The fake database really evaluates eq / neq / in / ilike / or / order / limit / insert / update, and it yields
 * to the event loop on every query, so two requests handled at the same moment genuinely interleave (needed to
 * test duplicate-webhook protection). After every write it dumps its tables to FAKE_DB_DUMP for the tests.
 *
 * Fake sessions (Bearer tokens): alice-token, bob-token, eve-token (verified customers),
 * unconfirmed-token (signed up but never confirmed the address).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..'); // .../server
const DUMP = process.env.FAKE_DB_DUMP;
const LOG = process.env.FAKE_CALL_LOG;
const log = (e) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(e) + '\n'); };

const DELAY = Number(process.env.FAKE_DB_DELAY_MS || 12); // milliseconds per query
// FAKE_DB_SHARED=1: several server PROCESSES share one database file (FAKE_DB_DUMP), to test cross-process behaviour.
const SHARED = process.env.FAKE_DB_SHARED === '1' && !!DUMP;
const tables = (SHARED && fs.existsSync(DUMP)) ? JSON.parse(fs.readFileSync(DUMP, 'utf8')) : JSON.parse(process.env.FAKE_DB_SEED || '{}');
tables.orders = tables.orders || [];
tables.ebooks = tables.ebooks || [];
const dump = () => {
  if (!DUMP) return;
  const tmp = DUMP + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tables));
  fs.renameSync(tmp, DUMP); // atomic replace, so another process never reads a half-written file
};
const reloadShared = () => {
  if (!SHARED) return;
  try { const fresh = JSON.parse(fs.readFileSync(DUMP, 'utf8')); for (const k of Object.keys(tables)) delete tables[k]; Object.assign(tables, fresh); } catch { /* keep memory copy */ }
};
if (!SHARED || !fs.existsSync(DUMP)) dump();

const USERS = {
  'alice-token': { id: 'u-alice', email: 'alice@example.com', email_confirmed_at: '2024-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} },
  'bob-token': { id: 'u-bob', email: 'bob@example.com', email_confirmed_at: '2024-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} },
  'eve-token': { id: 'u-eve', email: 'eve@example.com', email_confirmed_at: '2024-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} },
  'unconfirmed-token': { id: 'u-unconf', email: 'alice@example.com', email_confirmed_at: null, app_metadata: {}, user_metadata: {} },
};
const createdUsers = [];

const likeToRegex = (pattern) => {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'i');
};

let failedOnce = false;

class Query {
  constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.order_ = null; this.limit_ = null; this.single = false; }
  select() { return this; }
  insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.filters.push((r) => String(r[c]) !== String(v)); return this; }
  in(c, arr) { this.filters.push((r) => arr.map(String).includes(String(r[c]))); return this; }
  ilike(c, p) { const re = likeToRegex(String(p)); this.filters.push((r) => r[c] != null && re.test(String(r[c]))); return this; }
  or(str) {
    log({ call: 'or', filter: str });
    const parts = String(str).split(',').map((s) => { const m = s.match(/^([^.]+)\.(eq|ilike)\.(.*)$/); return m ? { c: m[1], op: m[2], v: m[3] } : null; }).filter(Boolean);
    this.filters.push((r) => parts.some((p) => (p.op === 'eq' ? String(r[p.c]) === p.v : r[p.c] != null && likeToRegex(p.v).test(String(r[p.c])))));
    return this;
  }
  order(c, o) { this.order_ = { c, asc: !o || o.ascending !== false }; return this; }
  limit(n) { this.limit_ = n; return this; }
  maybeSingle() { this.single = true; return this; }
  async exec() {
    await new Promise((r) => setTimeout(r, DELAY)); // a realistic database round-trip: concurrent requests genuinely interleave
    reloadShared();
    let rows = tables[this.table] || (tables[this.table] = []);
    const match = (r) => this.filters.every((f) => f(r));
    if (this.op === 'insert') {
      for (const row of this.rows) {
        if (this.table === 'orders' && process.env.FAIL_INSERT_ONCE_PRODUCT_ID && !failedOnce && row.product_id === process.env.FAIL_INSERT_ONCE_PRODUCT_ID) {
          failedOnce = true;
          return { data: null, error: { code: 'XX000', message: 'simulated database failure' } };
        }
        await new Promise((r) => setTimeout(r, DELAY));
        reloadShared();
        rows = tables[this.table] || (tables[this.table] = []);
        rows.push({ created_at: new Date().toISOString(), ...row });
      }
      dump();
      return { data: null, error: null };
    }
    if (this.op === 'update') { for (const r of rows.filter(match)) Object.assign(r, this.patch); dump(); return { data: null, error: null }; }
    if (this.op === 'delete') { tables[this.table] = rows.filter((r) => !match(r)); dump(); return { data: null, error: null }; }
    let out = rows.filter(match).map((r) => ({ ...r }));
    if (this.order_) out.sort((a, b) => (String(a[this.order_.c] ?? '') < String(b[this.order_.c] ?? '') ? -1 : 1) * (this.order_.asc ? 1 : -1));
    if (this.limit_) out = out.slice(0, this.limit_);
    return this.single ? { data: out[0] || null, error: null } : { data: out, error: null, count: out.length };
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
}

// Feature tables and SQL functions (entitlements, reader, Ask SID quota ...) run on a REAL PostgreSQL engine (PGlite) with the
// real migration applied. If PGlite is not installed the functions answer "not installed", which is exactly what an
// un-migrated production database does, so the backend falls back to its legacy rules.
const FEATURE_TABLES = new Set(['entitlement_settings', 'reader_books', 'reader_chapters', 'reading_progress', 'user_entitlements', 'launch_allocations',
  'entitlement_events', 'ask_sid_usage', 'webhook_events', 'companion_files', 'knowledge_chunks', 'admin_audit_log']);
let pg = null;
if (process.env.FAKE_PGLITE !== '0') {
  try {
    const { createPgSupabase } = require('./pglite-supabase.cjs');
    pg = createPgSupabase({ migrationPath: path.resolve(root, '..', 'supabase', 'migrations', '20261110_features_foundation.sql'), launchOpen: process.env.FAKE_LAUNCH_OPEN !== '0', seedSql: process.env.FAKE_PG_SEED_SQL });
    pg.ready.catch((e) => { console.error('[fake] PGlite failed:', e.message); });
    global.__FAKE_PG__ = pg;
  } catch (e) { pg = null; }
}
const notInstalled = { data: null, error: { code: 'PGRST202', message: 'Could not find the function (feature migration not installed)' } };

const supabase = {
  from: (t) => (pg && FEATURE_TABLES.has(t) ? pg.from(t) : new Query(t)),
  rpc: async (fn, args) => (pg ? pg.rpc(fn, args || {}) : notInstalled),
  storage: { from: (bucket) => ({ download: async (p) => { log({ call: 'storage.download', bucket, path: p }); return ({ data: new Blob([Buffer.from('%PDF-1.4 fake publication')]), error: null }); } }) },
  auth: {
    getUser: async (token) => (USERS[token] || /^user-[a-z0-9]+-token$/.test(String(token)) ? { data: { user: USERS[token] || (() => { const n = String(token).split('-')[1]; return { id: '00000000-0000-4000-8000-' + Buffer.from(n).toString('hex').padStart(12, '0').slice(0, 12), email: n + '@example.com', email_confirmed_at: '2024-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} }; })() }, error: null } : { data: { user: null }, error: { message: 'invalid token' } }),
    admin: {
      listUsers: async () => ({ data: { users: [...Object.values(USERS), ...createdUsers] }, error: null }),
      createUser: async ({ email }) => { const u = { id: 'new-' + createdUsers.length, email, email_confirmed_at: '2024-01-01T00:00:00Z' }; createdUsers.push(u); return { data: { user: u }, error: null }; },
      generateLink: async () => ({ data: { properties: { action_link: 'https://p.supabase.co/auth/v1/verify?token=T&type=recovery' } }, error: null }),
    },
  },
};

const stub = (request, exports_) => {
  const resolved = require.resolve(request, { paths: [root] });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exports_, children: [], paths: [] };
};
const noMail = async (opts) => { log({ call: 'mail', to: opts && opts.to, subject: opts && opts.subject }); return {}; };
stub(path.join(root, 'config', 'supabaseClient.js'), supabase);
stub(path.join(root, 'utils', 'orderEmail.js'), { sendOrderConfirmationEmail: noMail, sendSetPasswordEmail: noMail, sendPartialRefundAdminNotification: noMail });
stub('nodemailer', { createTransport: () => ({ sendMail: noMail }) });
