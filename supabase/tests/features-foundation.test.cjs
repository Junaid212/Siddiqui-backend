// Tests the REAL SQL of 20261110_features_foundation.sql on a real PostgreSQL engine (PGlite = Postgres compiled to WASM).
// Run:  npm i --no-save @electric-sql/pglite && node --test supabase/tests/features-foundation.test.cjs
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20261110_features_foundation.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20261110_features_foundation_rollback.sql'), 'utf8');
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
async function fresh() {
  const db = new PGlite();
  await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;');
  await db.exec(MIGRATION);
  await db.exec("update public.entitlement_settings set value = jsonb_set(value,'{launch_starts_at}','\"2000-01-01T00:00:00Z\"') where key='ask_sid_limits'"); // tests run with the launch offer OPEN unless they say otherwise
  return db;
}
async function freshClosed() { const db = new PGlite(); await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'); await db.exec(MIGRATION); return db; }
const j = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const grant = (db, n, email, edition, upg = false, paid = '2026-11-10T10:00:00Z') =>
  j(db, 'select public.grant_entitlement_for_order($1,$2,null,$3,$4,$5) r', [uuid(n), email, edition, upg, paid]).then((x) => x.r);
const reserve = (db, email) => j(db, 'select public.reserve_ask_sid_question($1,null) r', [email]).then((x) => x.r);

test('M1 migration applies cleanly and is idempotent (second run changes nothing)', async () => {
  const db = await fresh(); await db.exec(MIGRATION);
  const t = await db.query("select count(*)::int n from pg_tables where schemaname='public'"); assert.equal(t.rows[0].n, 12);
});
test('M2 rollback removes exactly the new objects and the migration can be re-applied', async () => {
  const db = await fresh(); await db.exec(ROLLBACK);
  assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")).rows[0].n, 0);
  await db.exec(MIGRATION);
});

test('E1 Online purchase: online entitlement only, no Ask SID fields, Ask SID refused with online_only', async () => {
  const db = await fresh(); const r = await grant(db, 1, 'A@x.com', 'online');
  assert.equal(r.result, 'granted'); assert.equal(r.edition, 'online');
  const e = await j(db, 'select * from public.user_entitlements'); assert.equal(e.edition, 'online'); assert.equal(e.ask_sid_expires_at, null); assert.equal(e.total_question_limit, null);
  assert.equal((await reserve(db, 'a@x.com')).reason, 'online_only');
});
test('E2 Companion purchase: companion only; never creates an online entitlement; Ask SID 12 months from purchase', async () => {
  const db = await fresh(); const r = await grant(db, 1, 'b@x.com', 'companion', false, '2026-11-10T10:00:00Z');
  assert.equal(r.edition, 'companion');
  const rows = (await db.query('select edition, ask_sid_expires_at from public.user_entitlements')).rows; assert.equal(rows.length, 1); assert.equal(rows[0].edition, 'companion');
  assert.equal(new Date(rows[0].ask_sid_expires_at).toISOString(), '2027-11-10T10:00:00.000Z');
});
test('E3 Upgrade: online revoked as upgraded, companion active, 12 months start at the upgrade date, history kept', async () => {
  const db = await fresh(); await grant(db, 1, 'c@x.com', 'online', false, '2026-11-01T00:00:00Z');
  const u = await grant(db, 2, 'c@x.com', 'companion', true, '2026-12-15T08:30:00Z'); assert.equal(u.result, 'granted');
  const rows = (await db.query('select edition,status,revoke_reason,is_upgrade,ask_sid_expires_at,granted_at,supersedes_id from public.user_entitlements order by granted_at')).rows;
  assert.equal(rows.length, 2); assert.equal(rows[0].status, 'revoked'); assert.equal(rows[0].revoke_reason, 'upgraded');
  assert.equal(rows[1].status, 'active'); assert.equal(rows[1].is_upgrade, true); assert.ok(rows[1].supersedes_id);
  assert.equal(new Date(rows[1].ask_sid_expires_at).toISOString(), '2027-12-15T08:30:00.000Z');
  const ev = (await db.query('select event_type from public.entitlement_events order by id')).rows.map((x) => x.event_type);
  assert.deepEqual(ev, ['granted_online', 'online_revoked', 'granted_companion_upgrade']);
});
test('E4 Online purchase while Companion is active is ignored (no downgrade, no combination)', async () => {
  const db = await fresh(); await grant(db, 1, 'd@x.com', 'companion');
  const r = await grant(db, 2, 'd@x.com', 'online'); assert.equal(r.result, 'skipped_companion_active');
  assert.equal((await db.query("select count(*)::int n from public.user_entitlements where status='active'")).rows[0].n, 1);
});
test('E5 The database itself forbids two active entitlements for one customer (unique index)', async () => {
  const db = await fresh(); await grant(db, 1, 'e@x.com', 'online');
  await assert.rejects(db.query("insert into public.user_entitlements (email, edition, ask_sid_expires_at, total_question_limit, daily_question_limit) values ('e@x.com','companion', now()+interval '1 year',100,5)"), /uq_ent_one_active|duplicate key/);
});
test('E6 Idempotent per order: replaying the same order changes nothing', async () => {
  const db = await fresh(); await grant(db, 1, 'f@x.com', 'companion'); const r = await grant(db, 1, 'f@x.com', 'companion');
  assert.equal(r.result, 'already_processed'); assert.equal((await db.query('select count(*)::int n from public.launch_allocations')).rows[0].n, 1);
});
test('E7 E-mail is normalised (case / spaces) so one customer cannot hold two entitlements', async () => {
  const db = await fresh(); await grant(db, 1, ' G@X.com ', 'companion'); const r = await grant(db, 2, 'g@x.com', 'companion'); assert.equal(r.result, 'skipped_companion_active');
});

test('L1 First 200 buyers get position 1..200 and 150 questions; buyer 201 gets 100; upgrades count', async () => {
  const db = await fresh();
  for (let i = 1; i <= 199; i++) await grant(db, i, `u${i}@x.com`, 'companion');
  await grant(db, 500, 'up@x.com', 'online'); const up = await grant(db, 501, 'up@x.com', 'companion', true);
  assert.equal(up.launch_position, 200); assert.equal(up.total_limit, 150);
  const b201 = await grant(db, 502, 'late@x.com', 'companion'); assert.equal(b201.launch_position, null); assert.equal(b201.total_limit, 100);
  const s = await j(db, 'select count(*)::int n, min(position) lo, max(position) hi from public.launch_allocations'); assert.deepEqual([s.n, s.lo, s.hi], [200, 1, 200]);
  assert.equal((await db.query("select count(*)::int n from public.user_entitlements where edition='companion' and total_question_limit=150")).rows[0].n, 200);
});
test('L2 Positions follow call order; a refund never frees or re-assigns a position', async () => {
  const db = await fresh(); const a = await grant(db, 1, 'a@x.com', 'companion'); const b = await grant(db, 2, 'b@x.com', 'companion');
  assert.deepEqual([a.launch_position, b.launch_position], [1, 2]);
  await j(db, "select public.revoke_entitlement_for_order($1,'full_refund') r", [uuid(1)]);
  const c = await grant(db, 3, 'c@x.com', 'companion'); assert.equal(c.launch_position, 3);
  const row = await j(db, 'select position, email from public.launch_allocations where position=1'); assert.equal(row.email, 'a@x.com');
});
test('L3 Re-buying after a refund is a new qualifying purchase (new position), not a re-use of the old one', async () => {
  const db = await fresh(); await grant(db, 1, 'a@x.com', 'companion'); await j(db, 'select public.revoke_entitlement_for_order($1) r', [uuid(1)]);
  const r = await grant(db, 2, 'a@x.com', 'companion'); assert.equal(r.result, 'granted'); assert.equal(r.launch_position, 2);
});
test('L0 Default: the launch offer is CLOSED until the owner opens it, so old/test orders can never take a position', async () => {
  const db = await freshClosed(); const r = await grant(db, 1, 'a@x.com', 'companion', false, new Date().toISOString());
  assert.equal(r.launch_position, null); assert.equal(r.total_limit, 100);
  assert.equal((await db.query('select count(*)::int n from public.launch_allocations')).rows[0].n, 0);
});
test('L4 launch_starts_at: purchases before the start date are not part of the offer', async () => {
  const db = await fresh(); await db.exec(`update public.entitlement_settings set value = jsonb_set(value,'{launch_starts_at}','"2026-11-20T00:00:00Z"') where key='ask_sid_limits'`);
  const early = await grant(db, 1, 'a@x.com', 'companion', false, '2026-11-10T00:00:00Z'); const late = await grant(db, 2, 'b@x.com', 'companion', false, '2026-11-21T00:00:00Z');
  assert.equal(early.launch_position, null); assert.equal(early.total_limit, 100); assert.equal(late.launch_position, 1); assert.equal(late.total_limit, 150);
});

test('Q1 Daily limit 5: sixth question is refused; committed questions count', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion', false, new Date(Date.now() - 86400e3).toISOString());
  for (let i = 0; i < 5; i++) { const r = await reserve(db, 'q@x.com'); assert.equal(r.allowed, true); await j(db, 'select public.commit_ask_sid_question($1) r', [r.usage_id]); }
  const r6 = await reserve(db, 'q@x.com'); assert.equal(r6.allowed, false); assert.equal(r6.reason, 'daily_limit'); assert.ok(r6.resets_at);
});
test('Q2 Rejected or failed questions are not charged (release frees the slot)', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion');
  for (let i = 0; i < 20; i++) { const r = await reserve(db, 'q@x.com'); assert.equal(r.allowed, true); await j(db, 'select public.release_ask_sid_question($1) r', [r.usage_id]); }
  const a = await j(db, 'select public.ask_sid_allowance(id) r from public.user_entitlements'); assert.equal(a.r.daily_used, 0); assert.equal(a.r.total_used, 0);
});
test('Q3 Unfinished reservations count only while fresh (2 minutes), so a crash cannot lock a customer out', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion');
  for (let i = 0; i < 5; i++) await reserve(db, 'q@x.com');
  assert.equal((await reserve(db, 'q@x.com')).reason, 'daily_limit');
  await db.exec("update public.ask_sid_usage set reserved_at = now() - interval '3 minutes'");
  assert.equal((await reserve(db, 'q@x.com')).allowed, true);
});
test('Q4 Total limit: 150 for launch buyers, 100 for others, across days', async () => {
  const db = await fresh(); await grant(db, 1, 'launch@x.com', 'companion');
  await db.exec(`update public.entitlement_settings set value = jsonb_set(value,'{launch_size}','1') where key='ask_sid_limits'`); await grant(db, 2, 'std@x.com', 'companion');
  for (const [email, limit] of [['launch@x.com', 150], ['std@x.com', 100]]) {
    const e = await j(db, 'select id from public.user_entitlements where email=$1', [email]);
    await db.query("insert into public.ask_sid_usage (entitlement_id, day, status) select $1, (now() at time zone 'UTC')::date - (g % 30 + 1), 'committed' from generate_series(1,$2) g", [e.id, limit - 1]);
    const ok = await reserve(db, email); assert.equal(ok.allowed, true); assert.equal(ok.total_limit, limit);
    await j(db, 'select public.commit_ask_sid_question($1) r', [ok.usage_id]);
    const no = await reserve(db, email); assert.equal(no.allowed, false); assert.equal(no.reason, 'total_limit');
  }
});
test('Q5 Expired Ask SID access (after 12 months) is rejected', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion', false, '2025-01-01T00:00:00Z');
  const r = await reserve(db, 'q@x.com'); assert.equal(r.allowed, false); assert.equal(r.reason, 'expired');
});
test('Q6 Full refund revokes Ask SID immediately; history kept', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion'); assert.equal((await reserve(db, 'q@x.com')).allowed, true);
  const rv = await j(db, 'select public.revoke_entitlement_for_order($1) r', [uuid(1)]); assert.equal(rv.r.result, 'revoked');
  assert.equal((await reserve(db, 'q@x.com')).reason, 'revoked');
  assert.equal((await db.query("select count(*)::int n from public.entitlement_events where event_type='revoked_full_refund'")).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int n from public.user_entitlements')).rows[0].n, 1);
});
test('Q7 Refund of the ORIGINAL online order after an upgrade does not touch the Companion entitlement', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'online'); await grant(db, 2, 'q@x.com', 'companion', true);
  const r = await j(db, 'select public.revoke_entitlement_for_order($1) r', [uuid(1)]); assert.equal(r.r.result, 'already_revoked');
  assert.equal((await reserve(db, 'q@x.com')).allowed, true);
});
test('Q8 Refund of the UPGRADE order revokes Companion and does not silently restore Online', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'online'); await grant(db, 2, 'q@x.com', 'companion', true);
  await j(db, 'select public.revoke_entitlement_for_order($1) r', [uuid(2)]);
  assert.equal((await db.query("select count(*)::int n from public.user_entitlements where status='active'")).rows[0].n, 0);
});
test('Q9 No entitlement at all is rejected', async () => { const db = await fresh(); assert.equal((await reserve(db, 'nobody@x.com')).reason, 'no_entitlement'); });
test('Q10 Daily counter is per UTC day: yesterday does not count today, total still does', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion', false, new Date(Date.now() - 5 * 86400e3).toISOString());
  const e = await j(db, 'select id from public.user_entitlements');
  await db.query("insert into public.ask_sid_usage (entitlement_id, day, status) select $1, (now() at time zone 'UTC')::date - 1, 'committed' from generate_series(1,5)", [e.id]);
  const r = await reserve(db, 'q@x.com'); assert.equal(r.allowed, true); assert.equal(r.daily_used, 1); assert.equal(r.total_used, 6);
});
test('Q11 A reservation cannot be committed after release', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion'); const r = await reserve(db, 'q@x.com');
  assert.equal((await j(db, 'select public.release_ask_sid_question($1) r', [r.usage_id])).r, true);
  assert.equal((await j(db, 'select public.commit_ask_sid_question($1) r', [r.usage_id])).r, false);
});

test('A1 Admin actions need a reason, are audited, and cannot restore a refunded entitlement', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion'); const e = await j(db, 'select id from public.user_entitlements');
  await assert.rejects(db.query("select public.admin_entitlement_action($1,'revoke',null,'',null,'x')", [e.id]), /reason_required/);
  await j(db, "select public.admin_entitlement_action($1,'add_questions',25,'goodwill after outage',$2,'admin@x.com') r", [e.id, uuid(99)]);
  assert.equal((await j(db, 'select public.ask_sid_allowance($1) r', [e.id])).r.total_limit, 175);
  await j(db, "select public.admin_entitlement_action($1,'extend_months',3,'support request',$2,'admin@x.com') r", [e.id, uuid(99)]);
  await j(db, "select public.admin_entitlement_action($1,'revoke',null,'chargeback dispute',$2,'admin@x.com') r", [e.id, uuid(99)]);
  await j(db, "select public.admin_entitlement_action($1,'restore',null,'dispute won',$2,'admin@x.com') r", [e.id, uuid(99)]);
  assert.equal((await db.query('select count(*)::int n from public.admin_audit_log')).rows[0].n, 4);
  await j(db, 'select public.revoke_entitlement_for_order($1) r', [uuid(1)]);
  await assert.rejects(db.query("select public.admin_entitlement_action($1,'restore',null,'trying to restore refund',null,'x')", [e.id]), /already_revoked|refunded_entitlement_cannot_be_restored|not_revoked/);
});
test('A2 The audit trail is append-only', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion');
  await assert.rejects(db.query("update public.entitlement_events set event_type='x'"), /append-only/);
  await assert.rejects(db.query('delete from public.entitlement_events'), /append-only/);
});

test('C1 Chapter re-ordering is atomic and rejects an incomplete or duplicated id list', async () => {
  const db = await fresh(); const b = await j(db, "insert into public.reader_books (slug,title) values ('mr','MR') returning id");
  const ids = []; for (const s of ['a', 'b', 'c']) ids.push((await j(db, 'insert into public.reader_chapters (book_id,slug,title,position) values ($1,$2,$2,0) returning id', [b.id, s])).id);
  await j(db, 'select public.reorder_reader_chapters($1,$2::uuid[]) r', [b.id, [ids[2], ids[0], ids[1]]]);
  assert.deepEqual((await db.query('select slug from public.reader_chapters order by position')).rows.map((r) => r.slug), ['c', 'a', 'b']);
  await assert.rejects(db.query('select public.reorder_reader_chapters($1,$2::uuid[])', [b.id, [ids[0], ids[1]]]), /chapter_list_mismatch/);
  await assert.rejects(db.query('select public.reorder_reader_chapters($1,$2::uuid[])', [b.id, [ids[0], ids[0], ids[1]]]), /chapter_list_mismatch/);
});
test('C2 Knowledge index: full-text search ranks the matching chunk first', async () => {
  const db = await fresh();
  await db.exec(`insert into public.knowledge_chunks (source,concept,chapter_ref,content) values
    ('book','Value Drift Index','Chapter 5','The Value Drift Index measures how far customer value has moved from what the firm offers.'),
    ('companion','Governance','Chapter 2','Governed strategic intelligence means evidence shapes decisions before they are locked.')`);
  const r = await db.query("select concept from public.knowledge_chunks where tsv @@ websearch_to_tsquery('english','value drift') order by ts_rank(tsv, websearch_to_tsquery('english','value drift')) desc");
  assert.equal(r.rows[0].concept, 'Value Drift Index');
});
test('S1 RLS: anon and authenticated roles cannot read any new table or call the engine functions', async () => {
  const db = await fresh(); await grant(db, 1, 'q@x.com', 'companion');
  await db.exec('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
  const tables = (await db.query("select tablename from pg_tables where schemaname='public'")).rows.map((r) => r.tablename);
  for (const role of ['anon', 'authenticated']) {
    for (const t of tables) { await db.exec(`SET ROLE ${role}`); let denied = false; try { await db.query(`select * from public.${t} limit 1`); } catch { denied = true; } await db.exec('RESET ROLE'); assert.ok(denied, `${role} must not read ${t}`); }
    await db.exec(`SET ROLE ${role}`); let fn = false; try { await db.query("select public.reserve_ask_sid_question('q@x.com', null)"); } catch { fn = true; } await db.exec('RESET ROLE'); assert.ok(fn, `${role} must not call the quota function`);
  }
});

test('K1 search_knowledge: returns the matching chunk with coverage counts; respects the source filter', async () => {
  const db = await fresh();
  await db.exec(`insert into public.knowledge_chunks (source,concept,chapter_ref,content,position) values
    ('book','Value Drift','Chapter 6','Value drift happens when growth erodes the trust of existing customers.',1),
    ('companion','Value Drift workbook','Companion, Chapter 6','Use the value drift diagnostic worksheet to score each customer segment.',2),
    ('book','Pricing','Chapter 5','Price is the exchange mechanism for perceived value.',3)`);
  const both = (await db.query("select * from public.search_knowledge('What is value drift?', array['book','companion'], 4)")).rows;
  assert.equal(both.length >= 2, true); assert.equal(both[0].total, 2); assert.equal(both[0].matched, 2);
  const bookOnly = (await db.query("select source from public.search_knowledge('What is value drift?', array['book'], 4)")).rows;
  assert.ok(bookOnly.every((r) => r.source === 'book'));
});
test('K2 search_knowledge: an off-topic question has poor coverage; a question of only stop words returns nothing', async () => {
  const db = await fresh();
  await db.exec(`insert into public.knowledge_chunks (source,concept,chapter_ref,content) values ('book','Capital allocation','Chapter 4','Capital must follow customer value, not internal habit.')`);
  const r = (await db.query("select matched, total from public.search_knowledge('What is the capital of France?', array['book'], 3)")).rows;
  assert.equal(r.length, 1); assert.ok(r[0].matched < r[0].total, 'one of the two meaningful words matches: coverage 1/2 is below the answer threshold');
  assert.equal((await db.query("select * from public.search_knowledge('what is the', array['book'], 3)")).rows.length, 0);
});

test('E8 A purchase claimed by another account moves its entitlement (and launch position) with the order; never onto an account that already has one', async () => {
  const db = await fresh(); const first = await grant(db, 1, 'old@x.com', 'companion');
  const moved = await grant(db, 1, 'new@x.com', 'companion'); assert.equal(moved.result, 'email_changed');
  assert.equal((await j(db, "select email, launch_position from public.user_entitlements")).email, 'new@x.com');
  assert.equal((await j(db, "select email from public.launch_allocations")).email, 'old@x.com', 'the allocation record keeps the original buyer');
  assert.equal((await reserve(db, 'old@x.com')).reason, 'no_entitlement'); assert.equal((await reserve(db, 'new@x.com')).allowed, true);
  await grant(db, 2, 'busy@x.com', 'companion'); await grant(db, 3, 'third@x.com', 'online');
  assert.equal((await grant(db, 3, 'busy@x.com', 'online')).result, 'email_change_blocked');
  assert.ok(first.launch_position === 1);
});
