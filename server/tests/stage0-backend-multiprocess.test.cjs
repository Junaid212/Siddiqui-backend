/**
 * Stage 0.5: duplicate Payhip deliveries are safe even when the API runs as SEVERAL PROCESSES on one server
 * (e.g. PM2 cluster mode or two overlapping restarts). Two real server processes share one database file and one lock
 * directory, and are hit with simultaneous duplicate deliveries.   Run (from the server folder):  node --test tests/*.test.cjs
 * Servers on DIFFERENT machines sharing one database still need the unique index documented in docs/STAGE0-SECURITY.md.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
const TMP = (n) => path.join(os.tmpdir(), `backend-mp-${process.pid}-${Date.now()}-${n}`);
const DB = TMP('db.json'), STORE = TMP('meta.json'), LOCKS = TMP('locks');
const KEY = 'test-payhip-key', SIG = crypto.createHash('sha256').update(KEY).digest('hex');
const BOOK = '04b84648-3609-4b31-9ded-2486bacf1e74';
const SEED = JSON.stringify({ ebooks: [{ id: BOOK, title: 'Marketing Reclassified', file_path: 'x.pdf', active: true }], orders: [] });
const base = 59900 + Math.floor(Math.random() * 40) * 2;
const PORTS = [base, base + 1];
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (port, p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0)));
const post = (port, body) => new Promise((resolve) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: '/api/webhooks/payhip', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', () => resolve(0)); r.write(d); r.end();
});
const start = (port) => spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'preload-fake-backend-deps.cjs'), path.join(SERVER, 'server.js')], { cwd: SERVER, stdio: 'ignore',
  env: { ...process.env, PORT: String(port), FAKE_DB_SEED: SEED, FAKE_DB_DUMP: DB, FAKE_DB_SHARED: '1', ORDERS_METADATA_PATH: STORE, WEBHOOK_LOCK_DIR: LOCKS, PAYHIP_API_KEY: KEY, NODE_ENV: 'test',
    FAKE_DB_DELAY_MS: '15', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE: 'x', PAYHIP_ONLINE_PRODUCT_ID: '', PAYHIP_COMPANION_PRODUCT_ID: '', PAYHIP_UPGRADE_PRODUCT_ID: '', PAYHIP_MAPPING_JSON: '' } });

test.before(async () => {
  fs.writeFileSync(STORE, '{}'); fs.mkdirSync(LOCKS, { recursive: true });
  procs.push(start(PORTS[0]));
  for (let i = 0; i < 100 && (await get(PORTS[0], '/api/health')) !== 200; i++) await sleep(100); // the first process writes the seed
  procs.push(start(PORTS[1]));
  for (let i = 0; i < 100 && (await get(PORTS[1], '/api/health')) !== 200; i++) await sleep(100);
  assert.equal(await get(PORTS[0], '/api/health'), 200); assert.equal(await get(PORTS[1], '/api/health'), 200);
});
test.after(() => { procs.forEach((p) => p.kill()); for (const f of [DB, STORE]) try { fs.unlinkSync(f); } catch { /* ignore */ } });

test('L1. 12 simultaneous duplicate deliveries spread over TWO server processes create exactly one order (3 rounds)', async () => {
  for (let round = 1; round <= 3; round++) {
    const txn = `MP-${round}-${Date.now()}`;
    const payload = { type: 'paid', id: txn, email: 'multi@example.com', price: 4999, currency: 'USD', signature: SIG, items: [{ product_id: '9500123', product_name: 'Marketing Reclassified (Digital Companion Edition)', product_key: '2H0Wr', product_permalink: 'https://payhip.com/b/2H0Wr', quantity: '1' }] };
    const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => post(PORTS[i % 2], payload)));
    assert.ok(codes.every((c) => c === 200), 'every delivery acknowledged: ' + codes.join());
    await sleep(150);
    const rows = JSON.parse(fs.readFileSync(DB, 'utf8')).orders.filter((o) => o.payhip_transaction_id === txn);
    assert.equal(rows.length, 1, `round ${round}: exactly one order row`);
  }
});

test('L2. fileLock: mutual exclusion, hashed lock names, stale-lock recovery and timeout', async () => {
  process.env.WEBHOOK_LOCK_DIR = TMP('unit-locks');
  const { withFileLock } = require('../utils/fileLock');
  // mutual exclusion: 20 tasks that read-modify-write a shared counter with a yield in the middle
  let counter = 0, maxInside = 0, inside = 0;
  await Promise.all(Array.from({ length: 20 }, () => withFileLock('same-key', async () => { inside++; maxInside = Math.max(maxInside, inside); const v = counter; await sleep(2); counter = v + 1; inside--; })));
  assert.equal(counter, 20); assert.equal(maxInside, 1, 'never two inside at once');
  // different keys do not block each other
  const t0 = Date.now(); await Promise.all([withFileLock('a', () => sleep(80)), withFileLock('b', () => sleep(80))]);
  assert.ok(Date.now() - t0 < 150, 'independent keys run in parallel');
  // a hostile name can never become a path
  await withFileLock('../../etc/passwd', async () => {});
  assert.ok(fs.readdirSync(process.env.WEBHOOK_LOCK_DIR).every((n) => /^[a-f0-9]{40}\.lock$/.test(n)) || fs.readdirSync(process.env.WEBHOOK_LOCK_DIR).length === 0);
  // a lock left behind by a crashed process is reclaimed
  const crypt = require('node:crypto');
  const stale = path.join(process.env.WEBHOOK_LOCK_DIR, crypt.createHash('sha256').update('crashed').digest('hex').slice(0, 40) + '.lock');
  fs.mkdirSync(stale); const old = new Date(Date.now() - 120_000); fs.utimesSync(stale, old, old);
  let ran = false; await withFileLock('crashed', async () => { ran = true; }, { staleMs: 60_000 }); assert.ok(ran, 'stale lock reclaimed');
  // a live lock that never frees up yields a LOCK_TIMEOUT (the webhook then answers 503 so Payhip retries)
  const live = path.join(process.env.WEBHOOK_LOCK_DIR, crypt.createHash('sha256').update('busy').digest('hex').slice(0, 40) + '.lock');
  fs.mkdirSync(live);
  await assert.rejects(() => withFileLock('busy', async () => {}, { timeoutMs: 150, staleMs: 600_000 }), (e) => e.code === 'LOCK_TIMEOUT');
  fs.rmdirSync(live);
});
