/**
 * Feature tests (Online Reading, Digital Companion, Ask SID, entitlements). The REAL server.js runs over HTTP against
 * the REAL SQL migration on an in-memory PostgreSQL engine (tests/helpers/pglite-supabase.cjs).
 * Run from the server folder:  npm i --no-save @electric-sql/pglite  &&  node --test tests/features-backend.test.cjs
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
const PORT = 58000 + Math.floor(Math.random() * 900);
const PORT2 = PORT - 3000; // 55000-55899: no overlap with the other test files (57000-57999 and 59000-59899), which run in parallel
const TMP = (n) => path.join(os.tmpdir(), `feat-backend-${process.pid}-${Date.now()}-${n}`);
const DB = TMP('db.json'), LOG = TMP('calls.log'), STORE = TMP('meta.json'), LOCKS = TMP('locks');
const KEY = 'test-payhip-key', SIG = crypto.createHash('sha256').update(KEY).digest('hex');
const BOOK = '04b84648-3609-4b31-9ded-2486bacf1e74';
const ID = { alice: '11111111-1111-4111-8111-111111111111', bob: '22222222-2222-4222-8222-222222222222' };
const row = (id, over) => ({ id, user_id: null, currency: 'USD', status: 'paid', product_id: BOOK, download_count: 0, download_limit: 3, payment_provider: 'payhip', created_at: '2026-10-01T00:00:00Z', ...over });
const SEED = { ebooks: [{ id: BOOK, title: 'Marketing Reclassified', file_path: 'ebooks/marketing-reclassified.pdf', active: true, price: 49 }], orders: [
  row(ID.alice, { user_id: 'u-alice', email: 'alice@example.com', order_number: 'ORD-ALICE-1', book_name: 'Marketing Reclassified — Online Reading Edition', amount: 20, access_tier: 'online', download_token: null, download_limit: 0 }),
  row(ID.bob, { user_id: 'u-bob', email: 'bob@example.com', order_number: 'ORD-BOB-1', book_name: 'Marketing Reclassified — Digital Companion Edition', amount: 49, access_tier: 'companion', download_token: 'tok-bob-companion' }),
] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function call(method, urlPath, { token, body, port = PORT, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text, type: res.headers['content-type'] || '', headers: res.headers }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const real = (key, name, extra = {}) => ({ product_id: '9' + String(key.length) + '00123', product_name: name, product_key: key, product_permalink: `https://payhip.com/b/${key}`, quantity: '1', on_sale: false, used_upgrade_discount: false, price: key === 'Nr3Tp' ? 2000 : key === 'IpN7k' ? 3000 : 4999, ...extra });
const evt = (type, id, items, email, extra = {}) => ({ type, id, email, price: items.reduce((n, i) => n + (i.price || 0), 0), currency: 'USD', signature: SIG, items, ...extra });
const send = (p) => call('POST', '/api/webhooks/payhip', { body: p });
const tok = (name) => `user-${name}-token`;
const buyOnline = (txn, name) => send(evt('paid', txn, [real('Nr3Tp', 'Online Reading')], `${name}@example.com`));
const buyCompanion = (txn, name) => send(evt('paid', txn, [real('2H0Wr', 'Digital Companion')], `${name}@example.com`));
const upgrade = (txn, name) => send(evt('paid', txn, [real('IpN7k', 'Upgrade')], `${name}@example.com`));
const refund = (txn, name, item) => send(evt('refunded', txn, [item], `${name}@example.com`, { amount_refunded: item.price }));
// each simulated customer comes from its own address, so the 30-requests-per-minute abuse limit does not couple unrelated tests
const ipOf = (name) => '10.1.' + (crypto.createHash('md5').update(String(name)).digest()[0]) + '.' + (crypto.createHash('md5').update(String(name)).digest()[1]);
const ask = (name, message, extra = {}) => call('POST', '/api/ask-sid/chat', { token: name ? tok(name) : undefined, headers: { 'x-forwarded-for': ipOf(name) }, body: { message, ...extra } });
const ordersOf = (email) => JSON.parse(fs.readFileSync(DB, 'utf8')).orders.filter((o) => o.email === email);

async function start(port, env) {
  const c = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'preload-fake-backend-deps.cjs'), path.join(SERVER, 'server.js')], { cwd: SERVER, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), FAKE_DB_SEED: JSON.stringify(SEED), FAKE_DB_DUMP: env.DB || DB, FAKE_CALL_LOG: LOG, ORDERS_METADATA_PATH: STORE, WEBHOOK_LOCK_DIR: LOCKS, PAYHIP_API_KEY: KEY, NODE_ENV: 'test', FAKE_DB_DELAY_MS: '2',
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE: 'x', ADMIN_EMAIL: 'owner-alerts@example.com', PAYHIP_COMPANION_PRODUCT_ID: '', PAYHIP_ONLINE_PRODUCT_ID: '', PAYHIP_UPGRADE_PRODUCT_ID: '', PAYHIP_MAPPING_JSON: '', ...env } });
  children.push(c); let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('exit', (code, sig) => { if (code !== null && code !== 0) console.error(`[test harness] server on port ${port} exited with code ${code}. Last output:\n` + out.split('\n').filter((l) => !/dotenv/.test(l)).slice(-15).join('\n')); });
  for (let i = 0; i < 200; i++) { try { if ((await call('GET', '/api/health', { port })).status === 200) return; } catch { /* starting */ } await sleep(100); }
  throw new Error('backend did not start:\n' + out.slice(-1500));
}
test.before(async () => {
  fs.writeFileSync(STORE, '{}'); fs.mkdirSync(LOCKS, { recursive: true });
  await start(PORT, { FAKE_PG_SEED_SQL: path.join(__dirname, 'helpers', 'features-seed.sql') });
  await call('GET', '/api/reader/access', { token: tok('warmup') }); // let the in-memory database finish starting
});
test.after(() => { for (const c of children) c.kill(); for (const f of [DB, LOG, STORE, DB + '2']) if (fs.existsSync(f)) fs.unlinkSync(f); });

// ---------------------------------------------------------------------------------------------------------------------
// R. Online Reading
// ---------------------------------------------------------------------------------------------------------------------
test('R1. the permission matrix is exactly the specified one', () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:9'; process.env.SUPABASE_SERVICE_ROLE = 'x';
  const { PERMISSIONS } = require('../utils/entitlements');
  assert.deepEqual(PERMISSIONS.online, { reader: true, companionDownloads: false, askSid: false });
  assert.deepEqual(PERMISSIONS.companion, { reader: false, companionDownloads: true, askSid: true });
  assert.deepEqual(PERMISSIONS.none, { reader: false, companionDownloads: false, askSid: false });
  assert.ok(Object.isFrozen(PERMISSIONS.online));
});

test('R2. an Online Reading buyer reads PUBLISHED chapters only, in order, with navigation', async () => {
  const b = await call('GET', '/api/reader/books', { token: 'alice-token' });
  assert.equal(b.status, 200); assert.deepEqual(b.json.books.map((x) => x.slug), ['marketing-reclassified-online']); assert.equal(b.json.books[0].chapterCount, 3);
  const book = await call('GET', '/api/reader/books/marketing-reclassified-online', { token: 'alice-token' });
  assert.deepEqual(book.json.chapters.map((c) => c.slug), ['principle-first-mandate', 'marketing-as-discipline', 'hostile-content']);
  const c1 = await call('GET', '/api/reader/books/marketing-reclassified-online/chapters/principle-first-mandate', { token: 'alice-token' });
  assert.equal(c1.status, 200); assert.equal(c1.json.previous, null); assert.equal(c1.json.next.slug, 'marketing-as-discipline'); assert.match(c1.json.chapter.contentHtml, /Published text/);
  assert.equal(c1.headers['cache-control'], 'private, no-store');
  const c2 = await call('GET', '/api/reader/books/marketing-reclassified-online/chapters/marketing-as-discipline', { token: 'alice-token' });
  assert.equal(c2.json.previous.slug, 'principle-first-mandate'); assert.equal(c2.json.next.slug, 'hostile-content');
});

test('R3. drafts, unpublished chapters and unpublished books are indistinguishable from missing (and never leak)', async () => {
  for (const url of ['/api/reader/books/marketing-reclassified-online/chapters/draft-chapter', '/api/reader/books/marketing-reclassified-online/chapters/withdrawn-chapter',
    '/api/reader/books/unreleased-book', '/api/reader/books/unreleased-book/chapters/hidden-book-chapter', '/api/reader/books/marketing-reclassified-online/chapters/nope', '/api/reader/books/..%2f/chapters/x']) {
    const r = await call('GET', url, { token: 'alice-token' }); assert.equal(r.status, 404, url); assert.ok(!/SECRET/.test(r.text));
  }
  const list = await call('GET', '/api/reader/books/marketing-reclassified-online', { token: 'alice-token' });
  assert.ok(!/SECRET|draft-chapter|withdrawn/.test(list.text), 'the chapter list holds published chapters only');
});

test('R4. a Digital Companion buyer, a customer with no purchase and anonymous visitors cannot use the reader', async () => {
  const bob = await call('GET', '/api/reader/books', { token: 'bob-token' }); assert.equal(bob.status, 403); assert.equal(bob.json.code, 'not_entitled');
  assert.equal((await call('GET', '/api/reader/books/marketing-reclassified-online/chapters/principle-first-mandate', { token: 'bob-token' })).status, 403);
  assert.equal((await call('GET', '/api/reader/books', { token: 'eve-token' })).status, 403);
  assert.equal((await call('GET', '/api/reader/books')).status, 401);
  assert.equal((await call('GET', '/api/reader/books', { token: 'unconfirmed-token' })).status, 403, 'unconfirmed e-mail');
  const acc = await call('GET', '/api/reader/access', { token: 'bob-token' }); assert.equal(acc.json.edition, 'companion'); assert.equal(acc.json.permissions.reader, false);
});

test('R5. the legacy PDF reader link no longer opens for a Digital Companion order', async () => {
  const l = await call('POST', `/api/payment/orders/${ID.bob}/access-link`, { token: 'bob-token', body: { purpose: 'read' } });
  const r = await call('GET', '/api' + l.json.path); assert.equal(r.status, 403); assert.equal(r.json.code, 'not_entitled');
  const l2 = await call('POST', `/api/payment/orders/${ID.alice}/access-link`, { token: 'alice-token', body: { purpose: 'read' } });
  assert.equal((await call('GET', '/api' + l2.json.path)).status, 200, 'the Online Reading buyer still opens the reader');
});

test('R6. reading progress: saved per customer, validated, resumable, isolated between customers', async () => {
  const put = (token, body) => call('PUT', '/api/reader/books/marketing-reclassified-online/progress', { token, body });
  assert.equal((await buyOnline('TXN-R6A', 'rita')).status, 200);
  assert.equal((await put(tok('rita'), { chapterSlug: 'marketing-as-discipline', percent: 42.5 })).status, 200);
  const resumed = (await call('GET', '/api/reader/books/marketing-reclassified-online', { token: tok('rita') })).json.progress;
  assert.equal(resumed.chapterSlug, 'marketing-as-discipline'); assert.equal(resumed.percent, 42.5);
  assert.equal((await put(tok('rita'), { chapterSlug: 'draft-chapter', percent: 10 })).status, 404, 'cannot save progress in an unpublished chapter');
  assert.equal((await put(tok('rita'), { chapterSlug: 'marketing-as-discipline', percent: 101 })).status, 400);
  assert.equal((await put(tok('rita'), { chapterSlug: 'marketing-as-discipline', percent: 'x' })).status, 400);
  assert.equal((await put('bob-token', { chapterSlug: 'marketing-as-discipline', percent: 5 })).status, 403);
  assert.equal((await buyOnline('TXN-R6B', 'zed')).status, 200);
  assert.equal((await call('GET', '/api/reader/books/marketing-reclassified-online', { token: tok('zed') })).json.progress, null, 'another customer starts fresh');
  assert.equal((await put(tok('rita'), { chapterSlug: 'principle-first-mandate', percent: 100 })).status, 200);
  assert.equal((await call('GET', '/api/reader/books/marketing-reclassified-online', { token: tok('rita') })).json.progress.chapterSlug, 'principle-first-mandate', 'the latest position replaces the previous one');
});

// ---------------------------------------------------------------------------------------------------------------------
// P. Purchase, upgrade and refund flows through the real Payhip webhook
// ---------------------------------------------------------------------------------------------------------------------
test('P1. Online purchase: reader yes; Companion downloads no; Ask SID gets the upgrade message', async () => {
  assert.equal((await buyOnline('TXN-P1', 'olive')).status, 200);
  assert.equal((await call('GET', '/api/reader/books', { token: tok('olive') })).status, 200);
  const a = await ask('olive', 'What is value drift?');
  assert.equal(a.status, 403); assert.equal(a.json.error, 'upgrade_required');
  assert.equal(a.json.message, 'Ask SID is available exclusively with the Digital Companion Edition. Upgrade your edition to unlock your AI book companion.');
  assert.ok(a.json.upgradeUrl);
  const order = ordersOf('olive@example.com')[0];
  assert.equal((await call('GET', `/api/payment/download/${order.id}`)).status, 403, 'no Companion download for an Online order');
});

test('P2. Companion purchase: downloads and Ask SID yes; reader no; no Online entitlement is ever created', async () => {
  assert.equal((await buyCompanion('TXN-P2', 'carol')).status, 200);
  assert.equal((await call('GET', '/api/reader/books', { token: tok('carol') })).status, 403);
  const acc = await call('GET', '/api/ask-sid/access', { token: tok('carol') });
  assert.equal(acc.json.edition, 'companion'); assert.equal(acc.json.hasCompanionAccess, true); assert.equal(acc.json.hasOnlineAccess, false);
  assert.equal(acc.json.allowance.dailyLimit, 5); assert.equal(acc.json.allowance.totalLimit, 150); assert.equal(acc.json.allowance.launchOffer, true);
  const dl = ordersOf('carol@example.com')[0];
  const file = await call('GET', `/api/payment/download/${dl.download_token}`); assert.equal(file.status, 200); assert.match(file.text, /^%PDF/);
});

test('P3. Upgrade: Online access ends, Companion access starts, the 12-month period starts on the upgrade date', async () => {
  assert.equal((await buyOnline('TXN-P3A', 'uma')).status, 200);
  assert.equal((await call('GET', '/api/reader/books', { token: tok('uma') })).status, 200);
  const before = Date.now();
  assert.equal((await upgrade('TXN-P3B', 'uma')).status, 200);
  assert.equal((await call('GET', '/api/reader/books', { token: tok('uma') })).status, 403, 'the reader is gone after the upgrade');
  const acc = await call('GET', '/api/ask-sid/access', { token: tok('uma') });
  assert.equal(acc.json.accessLevel, 'full'); assert.equal(acc.json.allowance.dailyLimit, 5);
  const expires = new Date(acc.json.allowance.expiresAt).getTime();
  const expected = new Date(before); expected.setUTCMonth(expected.getUTCMonth() + 12);
  assert.ok(Math.abs(expires - expected.getTime()) < 60 * 1000, 'expiry is 12 months from the upgrade, not from the original purchase');
  const rows = ordersOf('uma@example.com'); assert.equal(rows.length, 2, 'both transactions remain in the order history');
  const up = rows.find((o) => o.is_upgrade); assert.ok(up.download_token);
  assert.equal((await call('GET', `/api/payment/download/${up.download_token}`)).status, 200);
});

test('P4. Full refund removes downloads, Ask SID and (for Online) the reader at once; order history remains', async () => {
  const item = real('2H0Wr', 'Digital Companion');
  assert.equal((await buyCompanion('TXN-P4', 'dora')).status, 200);
  const tokenBefore = ordersOf('dora@example.com')[0].download_token;
  assert.equal((await ask('dora', 'What is value drift?')).status, 200);
  assert.equal((await refund('TXN-P4', 'dora', item)).status, 200);
  const after = await ask('dora', 'What does the value drift diagnostic worksheet score?', { demoSessionId: 'demo-dora' });
  assert.equal(after.json.isDemo, true, 'a refunded buyer is just a visitor again: no Companion allowance'); assert.equal(after.json.answer.outOfScope, true, 'Companion-only knowledge is gone');
  assert.equal((await call('GET', `/api/payment/download/${tokenBefore}`)).status < 400, false, 'the download token no longer works');
  assert.equal(ordersOf('dora@example.com').length, 1, 'the order is kept for auditing');
  assert.equal((await call('GET', '/api/ask-sid/access', { token: tok('dora') })).json.accessLevel, 'none');
  // online refund removes the reader
  assert.equal((await buyOnline('TXN-P4B', 'ollie')).status, 200); assert.equal((await call('GET', '/api/reader/books', { token: tok('ollie') })).status, 200);
  assert.equal((await refund('TXN-P4B', 'ollie', real('Nr3Tp', 'Online Reading'))).status, 200);
  assert.equal((await call('GET', '/api/reader/books', { token: tok('ollie') })).status, 403);
});

test('P5. A duplicate webhook delivery does not create a second entitlement or launch position', async () => {
  assert.equal((await buyCompanion('TXN-P5', 'dupe')).status, 200);
  const again = await buyCompanion('TXN-P5', 'dupe'); assert.equal(again.status, 200); assert.ok(again.json.idempotent);
  assert.equal(ordersOf('dupe@example.com').length, 1);
});

test('P6. Buying the Online edition after owning Companion never downgrades or combines access', async () => {
  assert.equal((await buyCompanion('TXN-P6A', 'cora')).status, 200);
  assert.equal((await buyOnline('TXN-P6B', 'cora')).status, 200);
  assert.equal((await call('GET', '/api/reader/books', { token: tok('cora') })).status, 403);
  assert.equal((await call('GET', '/api/ask-sid/access', { token: tok('cora') })).json.accessLevel, 'full');
});

// ---------------------------------------------------------------------------------------------------------------------
// A. Ask SID
// ---------------------------------------------------------------------------------------------------------------------
test('A1. a Companion customer gets a short, grounded answer that names the chapter/concept (standard AND Companion content)', async () => {
  await buyCompanion('TXN-A1', 'gina');
  const a = await ask('gina', 'What is value drift?');
  assert.equal(a.status, 200); assert.equal(a.json.answer.outOfScope, false);
  assert.ok(a.json.answer.text.split(/\s+/).length <= 150); assert.match(a.json.answer.text, /Value Drift/); assert.match(a.json.answer.text, /Chapter 6|Companion Pack/);
  assert.ok(!/\?\s*$/.test(a.json.answer.text), 'no follow-up question');
  const w = await ask('gina', 'What does the value drift diagnostic worksheet score?');
  assert.equal(w.status, 200); assert.match(w.json.answer.text, /worksheet/i); assert.equal(w.json.answer.sources[0].origin, 'companion', 'Companion-only knowledge is available to Companion customers');
});

test('A2. out-of-scope questions get the fixed sentence, no links, and are NOT charged', async () => {
  await buyCompanion('TXN-A2', 'hank');
  const before = (await call('GET', '/api/ask-sid/access', { token: tok('hank') })).json.allowance;
  for (const q of ['What is the capital of France?', 'Write me a Python script', 'Who won the football match yesterday', 'Give me the best marketing tactics from the web']) {
    const r = await ask('hank', q);
    assert.equal(r.status, 200, q); assert.equal(r.json.answer.outOfScope, true, q);
    assert.equal(r.json.answer.text, 'Ask SID covers the ideas in Marketing Reclassified. Please ask about a concept from the book.');
    assert.ok(!/https?:|www\./i.test(r.json.answer.text)); assert.equal(r.json.usage.charged, false);
  }
  const after = (await call('GET', '/api/ask-sid/access', { token: tok('hank') })).json.allowance;
  assert.equal(after.dailyUsed, before.dailyUsed); assert.equal(after.totalUsed, before.totalUsed);
});

test('A3. daily limit 5: the sixth question is refused with a clear message and the counters are right', async () => {
  await buyCompanion('TXN-A3', 'iris');
  for (let i = 1; i <= 5; i++) { const r = await ask('iris', 'What is value drift?'); assert.equal(r.status, 200, 'question ' + i); assert.equal(r.json.usage.dailyRemaining, 5 - i); }
  const sixth = await ask('iris', 'What is value drift?');
  assert.equal(sixth.status, 429); assert.equal(sixth.json.error, 'daily_limit'); assert.match(sixth.json.message, /5 questions.*00:00 UTC/);
  const acc = (await call('GET', '/api/ask-sid/access', { token: tok('iris') })).json.allowance;
  assert.equal(acc.dailyUsed, 5); assert.equal(acc.dailyRemaining, 0); assert.equal(acc.totalUsed, 5); assert.equal(acc.totalRemaining, 145);
});

test('A4. concurrent questions cannot bypass the daily limit (10 at once -> exactly 5 answered)', async () => {
  await buyCompanion('TXN-A4', 'jack');
  const rs = await Promise.all(Array.from({ length: 10 }, () => ask('jack', 'What is value drift?')));
  assert.equal(rs.filter((r) => r.status === 200).length, 5); assert.equal(rs.filter((r) => r.status === 429).length, 5);
  assert.equal((await call('GET', '/api/ask-sid/access', { token: tok('jack') })).json.allowance.totalUsed, 5);
});

test('A5. the standard allowance is 100 (150 only for launch-offer buyers); expired and refunded access is refused', async () => {
  // launch offer is open in the fixture: the first buyers have 150; verified through the allowance endpoint above (P2, A3).
  // Expiry and the 100/150 split are proven on the real SQL in supabase/tests (Q4, Q5); here the end-to-end refusal:
  assert.equal((await buyCompanion('TXN-A5', 'kate')).status, 200);
  assert.equal((await refund('TXN-A5', 'kate', real('2H0Wr', 'Digital Companion'))).status, 200);
  const r = await ask('kate', 'What does the value drift diagnostic worksheet score?', { demoSessionId: 'demo-kate' });
  assert.equal(r.json.isDemo, true); assert.equal(r.json.answer.outOfScope, true);
  assert.equal((await call('GET', '/api/ask-sid/access', { token: tok('kate') })).json.accessLevel, 'none');
});

test('A6. anonymous visitors and customers without a purchase get only the existing demo (standard book content, one question)', async () => {
  const q = 'What is the value drift diagnostic worksheet?'; // only Companion content answers this fully
  const demo1 = await ask(null, q, { demoSessionId: 'demo-1' });
  assert.equal(demo1.status, 200); assert.equal(demo1.json.isDemo, true); assert.equal(demo1.json.answer.outOfScope, true, 'Companion-only knowledge is NOT used for the demo');
  const demo2 = await ask(null, 'What is value drift?', { demoSessionId: 'demo-1' });
  assert.equal(demo2.status, 200); assert.ok(demo2.json.answer.sources.every((s) => s.origin === 'book'));
  const demo3 = await ask(null, 'What is value drift?', { demoSessionId: 'demo-1' });
  assert.equal(demo3.status, 403); assert.equal(demo3.json.error, 'demo_limit_reached');
  const eve = await ask('eve', 'Explain price competition', { demoSessionId: 'demo-eve' }); assert.equal(eve.status, 200); assert.equal(eve.json.isDemo, true);
});

test('A7. input is validated; an invalid or expired session is refused rather than silently downgraded', async () => {
  assert.equal((await call('POST', '/api/ask-sid/chat', { token: 'bob-token', body: { message: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/ask-sid/chat', { token: 'bob-token', body: { message: 'x'.repeat(601) } })).status, 400);
  assert.equal((await call('POST', '/api/ask-sid/chat', { token: 'garbage-token', body: { message: 'What is value drift?' } })).status, 401);
  assert.equal((await call('POST', '/api/ask-sid/chat', { token: 'bob-token', body: {} })).status, 400);
});

test('A8. a follow-up inside one conversation uses that conversation only; nothing is remembered between requests', async () => {
  await buyCompanion('TXN-A8', 'lena');
  const hist = [{ role: 'user', content: 'What is value drift?' }, { role: 'assistant', content: 'x' }];
  const withContext = await ask('lena', 'why?', { conversationHistory: hist });
  assert.equal(withContext.status, 200); assert.equal(withContext.json.answer.outOfScope, false);
  const alone = await ask('lena', 'why?');
  assert.equal(alone.json.answer.outOfScope, true, 'the same words in a new conversation have no context');
});

test('A9. reset-demo is not available in production', async () => {
  await start(PORT2 + 50, { NODE_ENV: 'production', FAKE_PG_SEED_SQL: path.join(__dirname, 'helpers', 'features-seed.sql'), DB: DB + '3' }).catch(() => {});
  const r = await call('POST', '/api/ask-sid/reset-demo', { port: PORT2 + 50, body: {} });
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------------------------------------------------
// F. Deployment safety: code deployed BEFORE the migration must change nothing for visitors
// ---------------------------------------------------------------------------------------------------------------------
test('F1. without the migration: downloads keep working as before, the reader says "not available", Ask SID uses the legacy engine', async () => {
  await start(PORT2, { FAKE_PGLITE: '0', DB: DB + '2' });
  const l = await call('POST', `/api/payment/orders/${ID.bob}/access-link`, { port: PORT2, token: 'bob-token', body: { purpose: 'download' } });
  const f = await call('GET', '/api' + l.json.path, { port: PORT2 }); assert.equal(f.status, 200); assert.match(f.text, /^%PDF/);
  assert.equal((await call('GET', '/api/reader/books', { port: PORT2, token: 'alice-token' })).status, 503);
  const a = await call('POST', '/api/ask-sid/chat', { port: PORT2, token: 'bob-token', body: { message: 'Why are my leads not converting?' } });
  assert.equal(a.status, 200); assert.ok(a.json.answer.understanding, 'legacy response shape');
});

test('A10. a question whose answer FAILS is not charged; a delivered answer is charged exactly once', async () => {
  const r = require('node:child_process').spawnSync(process.execPath, ['-r', path.join(__dirname, 'helpers', 'preload-fake-backend-deps.cjs'), path.join(__dirname, 'helpers', 'run-failed-ai.cjs')],
    { cwd: SERVER, encoding: 'utf8', env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE: 'x', FAKE_DB_DELAY_MS: '1' }, timeout: 60000 });
  const line = (r.stdout.split('\n').find((l) => l.startsWith('RESULT ')) || '');
  assert.ok(line, 'script output:\n' + r.stdout.slice(-500) + r.stderr.slice(-500));
  assert.deepEqual(JSON.parse(line.slice(7)), { failedStatus: 500, usedAfterFailure: 0, dailyAfterFailure: 0, deliveredStatus: 200, usedAfterSuccess: 1 });
});

test('D1. downloads serve the Companion PDF an administrator marked CURRENT (database), not the older per-server mapping', async () => {
  assert.equal((await buyCompanion('TXN-D1', 'dina')).status, 200);
  const o = ordersOf('dina@example.com')[0];
  assert.equal((await call('GET', `/api/payment/download/${o.download_token}`)).status, 200);
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.call === 'storage.download');
  assert.ok(calls.some((c) => c.path === 'companion/marketing-reclassified/v2-abcdef123456.pdf'), 'the current Companion file was requested: ' + JSON.stringify(calls.slice(-3)));
});
