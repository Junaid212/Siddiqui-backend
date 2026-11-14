/**
 * Stage 0 security tests for the CUSTOMER backend.  Run (from the server folder):  node --test tests/*.test.cjs
 *
 * The real server.js is started (random port) with its Supabase client and mailers replaced by in-memory fakes
 * (tests/helpers/preload-fake-backend-deps.cjs): no network, database or e-mail is used.
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
const PORT = 57000 + Math.floor(Math.random() * 1000);
const TMP = (n) => path.join(os.tmpdir(), `backend-stage0-${process.pid}-${Date.now()}-${n}`);
const DB = TMP('db.json'), LOG = TMP('calls.log'), STORE = TMP('orders-meta.json');
const KEY = 'test-payhip-key';
const SIG = crypto.createHash('sha256').update(KEY).digest('hex');

const DEFAULT_BOOK = '04b84648-3609-4b31-9ded-2486bacf1e74';
const VDI_BOOK = 'ba9acc66-a824-47c4-a4aa-5abb1a153437';
const ID = { alice: '11111111-1111-4111-8111-111111111111', bob: '22222222-2222-4222-8222-222222222222', carol: '33333333-3333-4333-8333-333333333333', dave: '44444444-4444-4444-8444-444444444444' };
const SEED = {
  ebooks: [{ id: DEFAULT_BOOK, title: 'Marketing Reclassified', file_path: 'ebooks/marketing-reclassified.pdf', active: true, price: 49, publication_status: 'published' }],
  orders: [
    { id: ID.alice, user_id: 'u-alice', email: 'alice@example.com', order_number: 'ORD-ALICE-1', book_name: 'Marketing Reclassified — Online Reading Edition', amount: 20, currency: 'USD', status: 'paid', access_tier: 'online', product_id: DEFAULT_BOOK, download_token: 'tok-alice-online', download_count: 0, download_limit: 0, payment_provider: 'payhip', created_at: '2026-01-01T00:00:00Z' },
    { id: ID.bob, user_id: 'u-bob', email: 'bob@example.com', order_number: 'ORD-BOB-1', book_name: 'Marketing Reclassified — Digital Companion Edition', amount: 49, currency: 'USD', status: 'paid', access_tier: 'companion', product_id: DEFAULT_BOOK, download_token: 'tok-bob-companion', download_count: 0, download_limit: 3, payment_provider: 'payhip', created_at: '2026-01-02T00:00:00Z' },
    { id: ID.carol, user_id: null, email: 'carol@example.com', order_number: 'ORD-CAROL-1', book_name: 'Marketing Reclassified — Digital Companion Edition', amount: 49, currency: 'USD', status: 'refunded', access_tier: 'companion', product_id: DEFAULT_BOOK, download_token: null, payment_provider: 'payhip', created_at: '2026-01-03T00:00:00Z' },
    { id: ID.dave, user_id: null, email: 'dave@example.com', order_number: 'ORD-DAVE-1', book_name: 'Marketing Reclassified — Digital Companion Edition', amount: 49, currency: 'USD', status: 'paid', refund_status: 'refunded', access_tier: 'companion', product_id: DEFAULT_BOOK, download_token: 'tok-dave', download_count: 0, download_limit: 3, payment_provider: 'payhip', created_at: '2026-01-04T00:00:00Z' },
  ],
};
let child;

const dbOrders = () => JSON.parse(fs.readFileSync(DB, 'utf8')).orders;
const txnRows = (txn) => dbOrders().filter((o) => o.payhip_transaction_id === txn);
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function call(method, urlPath, { token, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); const text = buf.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text, type: res.headers['content-type'] || '' }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  fs.writeFileSync(STORE, '{}'); // start with an empty metadata store (never the repository's seed file)
  child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'preload-fake-backend-deps.cjs'), path.join(SERVER, 'server.js')], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(PORT), FAKE_DB_SEED: JSON.stringify(SEED), FAKE_DB_DUMP: DB, FAKE_CALL_LOG: LOG, ORDERS_METADATA_PATH: STORE,
      PAYHIP_API_KEY: KEY, FAIL_INSERT_ONCE_PRODUCT_ID: VDI_BOOK, NODE_ENV: 'test', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE: 'x',
      PAYHIP_ONLINE_PRODUCT_ID: '', PAYHIP_COMPANION_PRODUCT_ID: '', PAYHIP_UPGRADE_PRODUCT_ID: '', PAYHIP_MAPPING_JSON: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 300; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('backend did not start:\n' + out.slice(-1200));
});
test.after(() => { if (child) child.kill(); for (const f of [DB, LOG, STORE]) if (fs.existsSync(f)) fs.unlinkSync(f); });

// ---------------------------------------------------------------------------------------------
// C. Order privacy
// ---------------------------------------------------------------------------------------------
test('C1. my-orders: an e-mail address alone returns nothing and never a download token', async () => {
  for (const url of ['/api/payment/my-orders?email=alice@example.com', '/api/payment/my-orders?email=bob%40example.com', '/api/payment/my-orders']) {
    const r = await call('GET', url);
    assert.equal(r.status, 401, url);
    assert.ok(!/tok-alice-online|tok-bob-companion|tok-dave/.test(r.text), 'no token may appear in the response');
    assert.equal(r.json.orders, undefined);
  }
});

test('C2. my-orders: invalid, expired and unconfirmed sessions are refused', async () => {
  assert.equal((await call('GET', '/api/payment/my-orders', { token: 'garbage' })).status, 401);
  const unconfirmed = await call('GET', '/api/payment/my-orders', { token: 'unconfirmed-token' });
  assert.equal(unconfirmed.status, 403, 'an unconfirmed address must not unlock someone else\'s orders');
  assert.ok(!/tok-alice-online/.test(unconfirmed.text));
});

test('C3. my-orders: a signed-in customer sees only their own orders; ?email= is ignored', async () => {
  const alice = await call('GET', '/api/payment/my-orders', { token: 'alice-token' });
  assert.equal(alice.status, 200);
  assert.deepEqual(alice.json.orders.map((o) => o.id), [ID.alice]);
  assert.equal(alice.json.orders[0].download_token, undefined, 'no reusable credential is listed; files are reached through short-lived links (see stage0-backend-access.test.cjs)');
  const spoof = await call('GET', '/api/payment/my-orders?email=bob@example.com', { token: 'alice-token' });
  assert.deepEqual(spoof.json.orders.map((o) => o.id), [ID.alice], 'asking for bob\'s e-mail with alice\'s session returns alice\'s orders only');
  assert.ok(!/tok-bob-companion/.test(spoof.text));
  const bob = await call('GET', '/api/payment/my-orders', { token: 'bob-token' });
  assert.deepEqual(bob.json.orders.map((o) => o.id), [ID.bob]);
  const eve = await call('GET', '/api/payment/my-orders', { token: 'eve-token' });
  assert.deepEqual(eve.json.orders, []);
});

test('C4. check-ownership: needs a session, answers for the session\'s own purchases, returns no order rows', async () => {
  for (const url of ['/api/payment/check-ownership?email=alice@example.com', '/api/payment/check-ownership']) {
    const r = await call('GET', url);
    assert.equal(r.status, 401);
    assert.ok(!/tok-/.test(r.text) && r.json.owned === undefined);
  }
  const alice = await call('GET', '/api/payment/check-ownership', { token: 'alice-token' });
  assert.equal(alice.status, 200);
  assert.equal(alice.json.ownsOnline, true); assert.equal(alice.json.ownsCompanion, false); assert.equal(alice.json.canUpgrade, true);
  assert.equal(alice.json.orders, undefined, 'raw order rows (with tokens) are no longer returned');
  assert.ok(!/tok-/.test(alice.text));
  const bob = await call('GET', '/api/payment/check-ownership?email=alice@example.com', { token: 'bob-token' });
  assert.equal(bob.json.ownsCompanion, true); assert.equal(bob.json.ownsOnline, false, 'bob cannot learn alice\'s purchases');
  assert.equal((await call('GET', '/api/payment/check-ownership', { token: 'eve-token' })).json.owned, false);
});

test('C5. replacement-link request: no wildcard matching, no filter injection, only valid e-mail addresses', async () => {
  for (const email of ['%@example.com', 'a%b@example.com', 'x@exa,mple.com', 'no-at-sign', '']) {
    const r = await call('POST', '/api/payment/request-replacement', { body: { email } });
    assert.equal(r.status, 400, `rejected: ${email}`);
  }
  // "_" is a legal e-mail character, so it is accepted, but it must be matched LITERALLY, never as a one-character
  // wildcard: "a_ice@..." must not find alice's order, and no link may be sent or rotated.
  const mailsBefore = readLog().filter((e) => e.call === 'mail').length;
  const tokenBefore = dbOrders().find((o) => o.id === ID.alice).download_token;
  for (const email of ['a_ice@example.com', '_@example.com', 'alic_@example.com']) {
    const r = await call('POST', '/api/payment/request-replacement', { body: { email } });
    assert.equal(r.status, 404, `no wildcard match for ${email}`);
  }
  assert.equal(readLog().filter((e) => e.call === 'mail').length, mailsBefore, 'no mail sent for wildcard look-alikes');
  assert.equal(dbOrders().find((o) => o.id === ID.alice).download_token, tokenBefore, 'alice\'s token was not rotated');
  const before = readLog().filter((e) => e.call === 'mail').length;
  const ok = await call('POST', '/api/payment/request-replacement', { body: { email: 'ALICE@example.com' } });
  assert.equal(ok.status, 200);
  assert.equal(readLog().filter((e) => e.call === 'mail').slice(before)[0].to, 'alice@example.com', 'link goes to the address on the order');
  await call('POST', '/api/payment/request-replacement', { body: { email: 'alice@example.com', orderNumber: 'x,id.neq.0)' } });
  const f = readLog().filter((e) => e.call === 'or' && e.filter.includes('order_number.ilike')).pop().filter;
  assert.equal(f, 'order_number.ilike.%xidneq0%,stripe_session_id.ilike.%xidneq0%,id.ilike.%xidneq0%', 'order number is reduced to safe characters');
});

// ---------------------------------------------------------------------------------------------
// D. Payhip default-deny
// ---------------------------------------------------------------------------------------------
const evt = (type, id, items, extra = {}) => ({ type, id, email: 'buyer@example.com', price: items.reduce((n, i) => n + (i.price || 0), 0), currency: 'USD', signature: SIG, items, ...extra });
const item = (key, name, price) => ({ product_id: 'internal-' + key, product_key: key, product_name: name, price });
const send = (payload) => call('POST', '/api/webhooks/payhip', { body: payload });

test('D1. webhook: wrong or missing signature is refused and stores nothing', async () => {
  const bad = await send({ ...evt('paid', 'TXN-SIG-1', [item('Nr3Tp', 'x', 2000)]), signature: 'f'.repeat(64) });
  assert.equal(bad.status, 400);
  const { signature, ...unsigned } = evt('paid', 'TXN-SIG-2', [item('Nr3Tp', 'x', 2000)]);
  assert.equal((await send(unsigned)).status, 400);
  assert.equal(txnRows('TXN-SIG-1').length + txnRows('TXN-SIG-2').length, 0);
});

test('D2. webhook: UNKNOWN products are rejected and never become Digital Companion', async () => {
  const unknowns = [
    ['TXN-UNK-1', [item('QQQQQ', 'Some Other Book', 4999)]],
    ['TXN-UNK-2', [item('QQQQQ', 'Marketing Reclassified Companion Edition (look-alike)', 4999)]],
    ['TXN-UNK-3', [item('QQQQQ', 'Marketing Reclassified Online Reading', 2000)]],
    ['TXN-UNK-4', [item('QQQQQ', 'Upgrade', 2999)]],
    ['TXN-UNK-5', [{ product_name: '', price: 100 }]],
  ];
  for (const [txn, items] of unknowns) {
    const r = await send(evt('paid', txn, items));
    assert.equal(r.status, 422, txn);
    assert.equal(r.json.error, 'unsupported_product');
    assert.equal(txnRows(txn).length, 0, `${txn}: nothing granted`);
  }
  const mixed = await send(evt('paid', 'TXN-UNK-6', [item('Nr3Tp', 'Online', 2000), item('QQQQQ', 'Mystery', 999)]));
  assert.equal(mixed.status, 422, 'one unknown item rejects the whole event');
  assert.equal(txnRows('TXN-UNK-6').length, 0, 'the known item is not granted either');
});

test('D3. webhook: the three real editions are still recognised correctly', async () => {
  const cases = [['TXN-OK-ONLINE', 'Nr3Tp', 2000, 'online', false], ['TXN-OK-COMP', '2H0Wr', 4999, 'companion', false], ['TXN-OK-UPG', 'IpN7k', 2999, 'companion', true]];
  for (const [txn, key, price, tier, upgrade] of cases) {
    const r = await send(evt('paid', txn, [item(key, 'whatever the seller named it', price)]));
    assert.equal(r.status, 200, txn);
    const rows = txnRows(txn);
    assert.equal(rows.length, 1, txn);
    assert.equal(rows[0].access_tier, tier, `${key} tier`);
    assert.equal(Boolean(rows[0].is_upgrade), upgrade, `${key} upgrade flag`);
    assert.equal(rows[0].status, 'paid');
    if (tier === 'online') assert.equal(rows[0].download_token, null, 'online edition has no download token');
    else assert.ok(rows[0].download_token, 'companion edition gets a download token');
  }
  const framework = await send(evt('paid', 'TXN-OK-AVF', [item('avf', 'The Adaptive Value Framework', 1900)]));
  assert.equal(framework.status, 200, 'existing catalogue products keep working');
});

// ---------------------------------------------------------------------------------------------
// E. Duplicate / concurrent / partial-failure webhook safety
// ---------------------------------------------------------------------------------------------
test('E1. webhook: the same event delivered several times AT ONCE creates exactly one order', async () => {
  const payload = evt('paid', 'TXN-RACE-1', [item('2H0Wr', 'Companion', 4999)]);
  const results = await Promise.all(Array.from({ length: 8 }, () => send(payload)));
  assert.ok(results.every((r) => r.status === 200), 'all deliveries acknowledged');
  assert.equal(txnRows('TXN-RACE-1').length, 1, 'exactly one order row');
  assert.equal(results.filter((r) => r.json && r.json.idempotent).length, 7, 'seven were recognised as duplicates');
  await send(payload);
  assert.equal(txnRows('TXN-RACE-1').length, 1, 'a later retry is still a no-op');
});

test('E2. webhook: a failed database write is NOT reported as success, and the retry finishes the remaining items only', async () => {
  const payload = evt('paid', 'TXN-PART-1', [item('Nr3Tp', 'Online', 2000), item('vdi', 'Value drift index', 1900)]);
  const first = await send(payload);
  assert.equal(first.status, 500, 'Payhip must be told to retry (it used to be told "received")');
  assert.equal(txnRows('TXN-PART-1').length, 1, 'item 1 stored, item 2 failed');
  const retry = await send(payload);
  assert.equal(retry.status, 200);
  assert.equal(txnRows('TXN-PART-1').length, 2, 'only the missing item was added (no duplicate of item 1)');
  assert.deepEqual(txnRows('TXN-PART-1').map((o) => o.product_id).sort(), [DEFAULT_BOOK, VDI_BOOK].sort());
  await send(payload);
  assert.equal(txnRows('TXN-PART-1').length, 2, 'fully processed: further retries change nothing');
});

// ---------------------------------------------------------------------------------------------
// F. Refunds revoke access
// ---------------------------------------------------------------------------------------------
test('F1. full refund via webhook revokes the download token and every download / reader route', async () => {
  await send(evt('paid', 'TXN-REF-1', [item('2H0Wr', 'Companion', 4999)]));
  const order = txnRows('TXN-REF-1')[0];
  assert.equal((await call('GET', `/api/payment/download/${order.download_token}`)).status, 200, 'works before the refund');
  const r = await send(evt('refunded', 'TXN-REF-1', [item('2H0Wr', 'Companion', 4999)], { price: 4999 }));
  assert.equal(r.status, 200);
  const after = txnRows('TXN-REF-1')[0];
  assert.equal(after.status, 'refunded'); assert.equal(after.download_token, null);
  for (const p of [`/api/payment/download/${order.id}`, `/api/payment/read/${order.id}`, `/api/payment/ebooks/download/${order.id}`]) {
    assert.equal((await call('GET', p)).status, 403, p);
  }
  // the old token no longer exists at all (cleared), so it can never be replayed
  const replay = await call('GET', `/api/payment/download/${order.download_token}`);
  assert.ok([403, 404].includes(replay.status), `old token must not work (got ${replay.status})`);
  assert.ok(!/^%PDF/.test(replay.text));
  assert.equal((await call('GET', `/api/payment/order-status/${order.id}`)).json.order.isRefunded, true);
});

test('F2. an order marked only by refund_status (status still "paid") is also denied everywhere', async () => {
  for (const p of ['/api/payment/download/tok-dave', `/api/payment/download/${ID.dave}`, `/api/payment/read/${ID.dave}`]) {
    assert.equal((await call('GET', p)).status, 403, p);
  }
  const s = (await call('GET', `/api/payment/order-status/${ID.dave}`)).json.order;
  assert.equal(s.isRefunded, true); assert.equal(s.isPaid, false);
  assert.equal((await call('GET', `/api/payment/download/${ID.carol}`)).status, 403, 'status=refunded stays denied');
});

test('F3. a refund that arrives BEFORE its payment cannot be undone by the late payment event', async () => {
  const early = await send(evt('refunded', 'TXN-EARLY-1', [item('2H0Wr', 'Companion', 4999)], { price: 4999 }));
  assert.equal(early.status, 200); assert.equal(early.json.refund_recorded, true);
  const late = await send(evt('paid', 'TXN-EARLY-1', [item('2H0Wr', 'Companion', 4999)]));
  assert.equal(late.status, 200); assert.equal(late.json.ignored, 'already_refunded');
  assert.equal(txnRows('TXN-EARLY-1').length, 0, 'no order, so no access');
});

// ---------------------------------------------------------------------------------------------
// G. Existing customer flows still work
// ---------------------------------------------------------------------------------------------
test('G1. existing behaviour is preserved: catalogue, paid downloads, online reader, online-only download block', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/api/payment/products')).status, 200);
  const dl = await call('GET', '/api/payment/download/tok-bob-companion');
  assert.equal(dl.status, 200); assert.match(dl.type, /pdf/); assert.match(dl.text, /^%PDF/);
  const read = await call('GET', `/api/payment/read/${ID.alice}`); // by order id: C5 legitimately rotated alice's token
  assert.equal(read.status, 200); assert.match(read.type, /pdf/);
  const blocked = await call('GET', `/api/payment/download/${ID.alice}`);
  assert.equal(blocked.status, 403, 'online-only buyers still cannot download the PDF');
  assert.equal((await call('GET', `/api/payment/order-status/${ID.bob}`)).json.order.isPaid, true);
  const noToken = await call('GET', '/api/payment/download');
  assert.equal(noToken.status, 400);
});

// ---------------------------------------------------------------------------------------------
// H. Pre-deployment mapping check (read-only script)
// ---------------------------------------------------------------------------------------------
test('H1. verify-payhip-mapping reports which stored products would be accepted or rejected', () => {
  const { analyse } = require('../scripts/verify-payhip-mapping.js');
  const { mapPayhipProductToBook } = require('../utils/payhipVerifier');
  const orders = [
    { access_tier: 'online', raw_metadata: { payhip_payload: { items: [{ product_key: 'Nr3Tp', product_name: 'Online', price: 2000 }] } } },
    { access_tier: 'companion', raw_metadata: { payhip_payload: { items: [{ product_key: '2H0Wr', product_name: 'Companion', price: 4999 }] } } },
    { access_tier: 'companion', raw_metadata: { payhip_payload: { items: [{ product_key: 'ZZZZZ', product_name: 'Look-alike Companion', price: 4999 }] } } },
    { access_tier: 'companion', book_name: 'Marketing Reclassified Companion', amount: 49, raw_metadata: {} },
  ];
  const groups = analyse(orders, mapPayhipProductToBook);
  assert.equal(groups.find((g) => g.product_key === 'Nr3Tp').result, 'online');
  assert.equal(groups.find((g) => g.product_key === '2H0Wr').result, 'companion');
  assert.equal(groups.find((g) => g.product_key === 'ZZZZZ').result, 'REJECT');
  assert.equal(groups.filter((g) => g.result === 'REJECT').length, 1, 'the look-alike product key is REJECTED');
  assert.equal(groups.filter((g) => g.result === 'UNVERIFIABLE (no stored payload)').length, 1, 'a row stored without a payload is UNVERIFIABLE, not rejected');
  assert.equal(groups.find((g) => g.product_key === 'Nr3Tp').mismatch, false);
});

test('H2. catalogue self-test: every Payhip id configured in the product records maps to the tier it is configured for', () => {
  const { catalogueSelfTest } = require('../scripts/verify-payhip-mapping.js');
  const { mapPayhipProductToBook } = require('../utils/payhipVerifier');
  const ebooks = [{ title: 'Marketing Reclassified', access_options: [
    { name: 'Online Reading Edition', access_type: 'online', payhip_product_id: 'Nr3Tp', upgrade_payhip_product_id: 'IpN7k' },
    { name: 'Digital Companion Edition', access_type: 'companion', payhip_product_id: '2H0Wr', upgrade_payhip_product_id: 'IpN7k' } ] }];
  const rows = catalogueSelfTest(ebooks, mapPayhipProductToBook);
  assert.equal(rows.length, 4); assert.ok(rows.every((r) => r.ok), JSON.stringify(rows.filter((r) => !r.ok)));
  // a mis-typed id in the catalogue is caught
  const bad = catalogueSelfTest([{ title: 'X', access_options: [{ name: 'Companion', access_type: 'companion', payhip_product_id: '2H0Wx' }] }], mapPayhipProductToBook);
  assert.equal(bad[0].ok, false); assert.equal(bad[0].gotTier, null);
  // an edition configured as 'online' but pointing at the Companion key is caught
  const swapped = catalogueSelfTest([{ title: 'X', access_options: [{ name: 'Online', access_type: 'online', payhip_product_id: '2H0Wr' }] }], mapPayhipProductToBook);
  assert.equal(swapped[0].ok, false);
});
