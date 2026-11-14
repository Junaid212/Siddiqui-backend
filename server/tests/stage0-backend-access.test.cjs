/**
 * Stage 0.5 backend tests: short-lived access links, credential rules, numeric Payhip ids and the rejected-product alert.
 * Run (from the server folder):  node --test tests/*.test.cjs
 * The real server.js is started against in-memory fakes (tests/helpers/preload-fake-backend-deps.cjs).
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
const PORT = 59000 + Math.floor(Math.random() * 900);
const TMP = (n) => path.join(os.tmpdir(), `backend-access-${process.pid}-${Date.now()}-${n}`);
const DB = TMP('db.json'), LOG = TMP('calls.log'), STORE = TMP('meta.json'), LOCKS = TMP('locks');
const KEY = 'test-payhip-key', SIG = crypto.createHash('sha256').update(KEY).digest('hex');
const BOOK = '04b84648-3609-4b31-9ded-2486bacf1e74';
const ID = { alice: '11111111-1111-4111-8111-111111111111', bob: '22222222-2222-4222-8222-222222222222', legacy: '55555555-5555-4555-8555-555555555555' };
const row = (id, over) => ({ id, user_id: null, currency: 'USD', status: 'paid', product_id: BOOK, download_count: 0, download_limit: 3, payment_provider: 'payhip', ...over });
const SEED = { ebooks: [{ id: BOOK, title: 'Marketing Reclassified', file_path: 'ebooks/marketing-reclassified.pdf', active: true, price: 49 }], orders: [
  row(ID.alice, { user_id: 'u-alice', email: 'alice@example.com', order_number: 'ORD-ALICE-1', book_name: 'Marketing Reclassified — Online Reading Edition', amount: 20, access_tier: 'online', download_token: 'tok-alice-online', download_limit: 0, payhip_transaction_id: 'TXN-ALICE-1', paypal_order_id: 'PP-ALICE-1', created_at: '2026-01-01T00:00:00Z' }),
  row(ID.bob, { user_id: 'u-bob', email: 'bob@example.com', order_number: 'ORD-BOB-1', book_name: 'Marketing Reclassified — Digital Companion Edition', amount: 49, access_tier: 'companion', download_limit: 50, download_token: 'tok-bob-companion', payhip_transaction_id: 'TXN-BOB-1', stripe_session_id: 'cs_test_bobsession1234567890', created_at: '2026-01-02T00:00:00Z' }),
  // an older customer whose token has an older, non-hex format: it must keep working
  row(ID.legacy, { user_id: null, email: 'legacy@example.com', order_number: 'ORD-LEGACY-1', book_name: 'Marketing Reclassified — Digital Companion Edition', amount: 49, access_tier: 'companion', download_token: 'token_legacy_style_1700000000000', created_at: '2026-01-03T00:00:00Z' }),
] };
let child;
const dbOrders = () => JSON.parse(fs.readFileSync(DB, 'utf8')).orders;
const txnRows = (t) => dbOrders().filter((o) => o.payhip_transaction_id === t);
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text, type: res.headers['content-type'] || '', disposition: res.headers['content-disposition'] || '' }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// The shape Payhip documents for items[] (help article 115): numeric product_id, product_name, product_key, product_permalink, quantity ...
const real = (key, name, extra = {}) => ({ product_id: '9' + String(key.length) + '00123', product_name: name, product_key: key, product_permalink: `https://payhip.com/b/${key}`, quantity: '1', on_sale: false, used_upgrade_discount: false, ...extra });
const evt = (type, id, items, extra = {}) => ({ type, id, email: 'bob@example.com', price: items.reduce((n, i) => n + (i.price || 0), 0), currency: 'USD', signature: SIG, items, ...extra });
const send = (p) => call('POST', '/api/webhooks/payhip', { body: p });

test.before(async () => {
  fs.writeFileSync(STORE, '{}'); fs.mkdirSync(LOCKS, { recursive: true });
  child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'preload-fake-backend-deps.cjs'), path.join(SERVER, 'server.js')], { cwd: SERVER, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), FAKE_DB_SEED: JSON.stringify(SEED), FAKE_DB_DUMP: DB, FAKE_CALL_LOG: LOG, ORDERS_METADATA_PATH: STORE, WEBHOOK_LOCK_DIR: LOCKS, PAYHIP_API_KEY: KEY, NODE_ENV: 'test', FAKE_DB_DELAY_MS: '3',
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE: 'x', ADMIN_EMAIL: 'owner-alerts@example.com',
      PAYHIP_COMPANION_PRODUCT_ID: '', PAYHIP_ONLINE_PRODUCT_ID: '111,222', PAYHIP_UPGRADE_PRODUCT_ID: '333', PAYHIP_MAPPING_JSON: '' } });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 300; i++) { try { if ((await call('GET', '/api/health')).status === 200) return; } catch { /* starting */ } await sleep(100); }
  throw new Error('backend did not start:\n' + out.slice(-1000));
});
test.after(() => { if (child) child.kill(); for (const f of [DB, LOG, STORE]) if (fs.existsSync(f)) fs.unlinkSync(f); });

// ---------------------------------------------------------------------------------------------
// I. My Orders no longer lists reusable credentials; files are reached through short-lived links
// ---------------------------------------------------------------------------------------------
test('I1. my-orders lists NO download token and NO provider ids (only display fields)', async () => {
  const r = await call('GET', '/api/payment/my-orders', { token: 'alice-token' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.orders.map((o) => o.order_number), ['ORD-ALICE-1']);
  for (const field of ['download_token', 'paypal_order_id', 'payhip_transaction_id', 'stripe_session_id', 'paypal_capture_id']) assert.equal(r.json.orders[0][field], undefined, field);
  assert.ok(!/tok-alice-online|TXN-ALICE-1|PP-ALICE-1/.test(r.text), 'no credential appears anywhere in the response body');
  assert.ok(r.json.orders[0].id && r.json.orders[0].book_name && r.json.orders[0].access_tier, 'display fields remain');
});

test('I2. access link: owner downloads through it; the link is a path, not a token', async () => {
  const l = await call('POST', `/api/payment/orders/${ID.bob}/access-link`, { token: 'bob-token', body: { purpose: 'download' } });
  assert.equal(l.status, 200);
  assert.match(l.json.path, /^\/payment\/access\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(l.json.expiresIn, 120);
  assert.ok(!l.text.includes('tok-bob-companion'), 'the link response contains no stored credential');
  const file = await call('GET', '/api' + l.json.path);
  assert.equal(file.status, 200); assert.match(file.type, /pdf/); assert.match(file.disposition, /attachment/); assert.match(file.text, /^%PDF/);
});

test('I3. access link: the online reader works through a "read" link (inline PDF)', async () => {
  const l = await call('POST', `/api/payment/orders/${ID.alice}/access-link`, { token: 'alice-token', body: { purpose: 'read' } });
  assert.equal(l.status, 200);
  const file = await call('GET', '/api' + l.json.path);
  assert.equal(file.status, 200); assert.match(file.type, /pdf/); assert.match(file.disposition, /inline/);
});

test('I4. access link: only the owner can obtain one; other customers get 404, anonymous 401, bad input 400', async () => {
  const mine = (token, id = ID.bob, purpose = 'download') => call('POST', `/api/payment/orders/${id}/access-link`, { token, body: { purpose } });
  assert.equal((await mine('alice-token')).status, 404, 'alice asking for bob\'s order');
  assert.equal((await mine('eve-token')).status, 404, 'a customer with no orders');
  assert.equal((await mine('garbage')).status, 401);
  assert.equal((await call('POST', `/api/payment/orders/${ID.bob}/access-link`, { body: { purpose: 'download' } })).status, 401);
  assert.equal((await mine('unconfirmed-token', ID.alice)).status, 403, 'an unconfirmed e-mail account cannot mint links');
  assert.equal((await mine('bob-token', 'not-a-uuid')).status, 400);
  assert.equal((await mine('bob-token', ID.bob, 'delete')).status, 400);
  assert.equal((await mine('bob-token', '99999999-9999-4999-8999-999999999999')).status, 404, 'unknown order');
});

test('I5. access link: tampered, forged or swapped links are refused', async () => {
  const l = (await call('POST', `/api/payment/orders/${ID.bob}/access-link`, { token: 'bob-token', body: { purpose: 'download' } })).json.path;
  const signed = l.split('/').pop(); const [payload, sig] = signed.split('.');
  const flip = (s) => s.slice(0, -1) + (s.slice(-1) === 'A' ? 'B' : 'A');
  assert.equal((await call('GET', `/api/payment/access/${payload}.${flip(sig)}`)).status, 403, 'bad signature');
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), o: ID.alice })).toString('base64url');
  assert.equal((await call('GET', `/api/payment/access/${other}.${sig}`)).status, 403, 'payload swapped to another order');
  for (const bad of ['garbage', 'a.b', '.', payload, `${payload}.`, 'x'.repeat(700)]) assert.equal((await call('GET', `/api/payment/access/${bad}`)).status, 403, bad.slice(0, 20));
});

test('I6. access link: expiry and purpose are enforced by the signer (unit)', () => {
  process.env.ACCESS_LINK_SECRET = 'unit-test-secret-unit-test-secret-unit';
  const { signAccess, verifyAccess, resetKeyCacheForTests } = require('../utils/accessLinks');
  resetKeyCacheForTests();
  const now = Date.now();
  const link = signAccess({ orderId: ID.bob, purpose: 'download', ttlSeconds: 120, nowMs: now });
  assert.deepEqual(verifyAccess(link, { nowMs: now + 119_000 }), { orderId: ID.bob, purpose: 'download' }, 'valid just before expiry');
  assert.equal(verifyAccess(link, { nowMs: now + 121_000 }), null, 'expired');
  assert.equal(verifyAccess(signAccess({ orderId: ID.bob, purpose: 'read', nowMs: now }), { nowMs: now }).purpose, 'read');
  assert.throws(() => signAccess({ orderId: ID.bob, purpose: 'admin' }));
  assert.equal(verifyAccess(null), null); assert.equal(verifyAccess(12345), null);
  process.env.ACCESS_LINK_SECRET = 'a-DIFFERENT-secret-a-DIFFERENT-secret-xx'; resetKeyCacheForTests();
  assert.equal(verifyAccess(link, { nowMs: now }), null, 'a link signed with another key is rejected');
  delete process.env.ACCESS_LINK_SECRET; resetKeyCacheForTests();
});

test('I7. access link: every rule is re-checked when the link is USED (edition rule, refund after issuing)', async () => {
  // online-only edition may never download a PDF, even through a valid link
  const dl = await call('POST', `/api/payment/orders/${ID.alice}/access-link`, { token: 'alice-token', body: { purpose: 'download' } });
  assert.equal(dl.status, 200);
  assert.equal((await call('GET', '/api' + dl.json.path)).status, 403, 'online edition: no PDF download');
  // a purchase made via Payhip, link issued, THEN refunded: the already-issued link must stop working
  const item = real('2H0Wr', 'Marketing Reclassified (Digital Companion Edition)');
  assert.equal((await send(evt('paid', 'TXN-LINK-1', [item]))).status, 200);
  const order = txnRows('TXN-LINK-1')[0];
  const link = await call('POST', `/api/payment/orders/${order.id}/access-link`, { token: 'bob-token', body: { purpose: 'download' } });
  assert.equal(link.status, 200, 'owner (by e-mail) gets a link for the new order');
  assert.equal((await send(evt('refunded', 'TXN-LINK-1', [item], { price: 4999 }))).status, 200);
  assert.equal((await call('GET', '/api' + link.json.path)).status, 403, 'refunded after issuing: denied at use');
  assert.equal((await call('POST', `/api/payment/orders/${order.id}/access-link`, { token: 'bob-token', body: { purpose: 'download' } })).status, 403, 'and no new link can be issued');
});

// ---------------------------------------------------------------------------------------------
// J. Legacy links: order numbers / provider ids are NOT credentials; real credentials still work
// ---------------------------------------------------------------------------------------------
test('J1. legacy download / reader links reject order numbers and provider transaction ids', async () => {
  for (const weak of ['ORD-BOB-1', 'TXN-BOB-1', 'ORD-ALICE-1', 'TXN-ALICE-1', 'PP-ALICE-1']) {
    for (const p of [`/api/payment/download/${weak}`, `/api/payment/read/${weak}`, `/api/payment/ebooks/download/${weak}`, `/api/payment/download?token=${weak}`]) {
      const r = await call('GET', p);
      assert.equal(r.status, 404, p);
      assert.ok(!/^%PDF/.test(r.text), p);
    }
  }
});

test('J2. real credentials still work: random token, Stripe session id, order UUID, and an older token format', async () => {
  assert.equal((await call('GET', '/api/payment/download/tok-bob-companion')).status, 200, 'download token');
  assert.equal((await call('GET', '/api/payment/download/cs_test_bobsession1234567890')).status, 200, 'Stripe checkout session id');
  assert.equal((await call('GET', `/api/payment/download/${ID.bob}`)).status, 200, 'order UUID (kept for the post-purchase page)');
  assert.equal((await call('GET', '/api/payment/download/token_legacy_style_1700000000000')).status, 200, 'older token format is not locked out');
  assert.equal((await call('GET', `/api/payment/read/${ID.alice}`)).status, 200, 'online reader by UUID');
});

// ---------------------------------------------------------------------------------------------
// K. Payhip numeric product ids, configured id lists and the rejected-product alert
// ---------------------------------------------------------------------------------------------
const numeric = (id, name = 'x', price = 100) => ({ product_id: id, product_name: name, price, quantity: 1 }); // the shape real payloads have: NO product_key, NO link

test('K1. products are matched by the documented Payhip product_key / product_permalink (the configured Nr3Tp, 2H0Wr, IpN7k)', async () => {
  const cases = [['TXN-KEY-ON', real('Nr3Tp', 'Online Reading'), 'online', false], ['TXN-KEY-COMP', real('2H0Wr', 'Digital Companion'), 'companion', false], ['TXN-KEY-UP', real('IpN7k', 'Upgrade'), 'companion', true],
    ['TXN-KEY-DISC', real('2H0Wr', 'Digital Companion', { used_upgrade_discount: true }), 'companion', true]];
  for (const [txn, item, tier, upgrade] of cases) {
    assert.equal((await send(evt('paid', txn, [item]))).status, 200, txn);
    const r = txnRows(txn)[0]; assert.equal(r.access_tier, tier, txn); assert.equal(Boolean(r.is_upgrade), upgrade, txn + ' upgrade flag');
  }
  // permalink only (no product_key): still matched, because the key is the last part of the documented URL
  const permalinkOnly = real('2H0Wr', 'Digital Companion'); delete permalinkOnly.product_key;
  assert.equal((await send(evt('paid', 'TXN-KEY-PERMA', [permalinkOnly]))).status, 200); assert.equal(txnRows('TXN-KEY-PERMA')[0].access_tier, 'companion');
});

test('K1b. the Payhip DOCUMENTATION example (product_id 2804256 / key RGsF) is NOT one of our products and is rejected', async () => {
  const docSample = { product_id: '2804256', product_name: 'The Adventures of Sherlock Holmes', product_key: 'RGsF', product_permalink: 'https://payhip.com/b/RGsF', quantity: '1' };
  assert.equal((await send(evt('paid', 'TXN-DOCS-SAMPLE', [docSample]))).status, 422);
  assert.equal(txnRows('TXN-DOCS-SAMPLE').length, 0);
  // and the numeric id alone, as the old simulation scripts sent it, grants nothing
  assert.equal((await send(evt('paid', 'TXN-DOCS-SAMPLE-2', [numeric('2804256', 'Marketing Reclassified (Digital Companion Edition)', 4999)]))).status, 422);
  assert.equal(txnRows('TXN-DOCS-SAMPLE-2').length, 0);
});
test('K2. ids configured through PAYHIP_*_PRODUCT_ID (comma lists allowed) map to the right tier', async () => {
  assert.equal((await send(evt('paid', 'TXN-NUM-ON1', [numeric('111', 'Online')]))).status, 200);
  assert.equal((await send(evt('paid', 'TXN-NUM-ON2', [numeric('222', 'Online')]))).status, 200);
  assert.equal((await send(evt('paid', 'TXN-NUM-UP', [numeric('333', 'Upgrade')]))).status, 200);
  assert.equal(txnRows('TXN-NUM-ON1')[0].access_tier, 'online'); assert.equal(txnRows('TXN-NUM-ON2')[0].access_tier, 'online');
  assert.equal(txnRows('TXN-NUM-ON1')[0].download_token, null);
  const up = txnRows('TXN-NUM-UP')[0]; assert.equal(up.access_tier, 'companion'); assert.equal(up.is_upgrade, true);
});

test('K3. an unrecognised product is rejected (422), nothing is stored, and the owner is alerted ONCE per product', async () => {
  const mailsBefore = () => readLog().filter((e) => e.call === 'mail' && /NOT recognised/.test(e.subject || '')).length;
  const before = mailsBefore();
  const r1 = await send(evt('paid', 'TXN-UNK-ALERT-1', [numeric('7777777', 'Some New Book', 1500)]));
  assert.equal(r1.status, 422); assert.equal(txnRows('TXN-UNK-ALERT-1').length, 0);
  await sleep(400);
  assert.equal(mailsBefore(), before + 1, 'alert sent');
  const m = readLog().filter((e) => e.call === 'mail' && /NOT recognised/.test(e.subject || '')).pop();
  assert.equal(m.to, 'owner-alerts@example.com'); assert.ok(m.subject.includes('7777777'));
  assert.equal((await send(evt('paid', 'TXN-UNK-ALERT-2', [numeric('7777777', 'Some New Book', 1500)]))).status, 422);
  await sleep(300);
  assert.equal(mailsBefore(), before + 1, 'same product again: throttled, no second e-mail');
  assert.equal((await send(evt('paid', 'TXN-UNK-ALERT-3', [numeric('8888888', 'Another', 900)]))).status, 422);
  await sleep(400);
  assert.equal(mailsBefore(), before + 2, 'a different unknown product alerts again');
});
