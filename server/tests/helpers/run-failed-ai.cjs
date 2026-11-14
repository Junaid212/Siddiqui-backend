// Run with:  node -r tests/helpers/preload-fake-backend-deps.cjs tests/helpers/run-failed-ai.cjs
// Proves that when the answer step FAILS the reserved question is released (not charged), and that a delivered answer is charged once.
process.env.NODE_ENV = 'test';
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
(async () => {
  const supabase = require(path.join(root, 'config', 'supabaseClient.js'));
  await global.__FAKE_PG__.ready;
  await global.__FAKE_PG__.db.exec(`insert into public.knowledge_chunks (source, concept, chapter_ref, content) values ('book','Value Drift','Chapter 6','Value drift happens when growth erodes trust.')`);
  const g = await supabase.rpc('grant_entitlement_for_order', { p_order_id: '00000000-0000-4000-8000-0000000000aa', p_email: 'fail@example.com', p_user_id: null, p_edition: 'companion', p_is_upgrade: false, p_paid_at: new Date().toISOString(), p_catalog: 'marketing-reclassified' });
  const entId = g.data.entitlement_id;
  const engine = require(path.join(root, 'utils', 'askSidEngine.js'));
  const controller = require(path.join(root, 'controllers', 'askSidController.js'));
  const call = async (answerImpl) => {
    engine.answer = answerImpl;
    const req = { headers: { authorization: 'Bearer user-fail-token', 'x-forwarded-for': '10.9.9.9' }, body: { message: 'What is value drift?' }, socket: {} };
    return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } }; controller.askQuestion(req, res); });
  };
  const allowance = async () => (await supabase.rpc('ask_sid_allowance', { p_entitlement_id: entId })).data;
  const out = {};
  out.failed = await call(async () => { throw new Error('model unavailable'); });
  out.afterFailure = await allowance();
  out.delivered = await call(async () => ({ outOfScope: false, text: 'Value Drift (Chapter 6): ok', sources: [] }));
  out.afterSuccess = await allowance();
  console.log('RESULT ' + JSON.stringify({ failedStatus: out.failed.status, usedAfterFailure: out.afterFailure.total_used, dailyAfterFailure: out.afterFailure.daily_used, deliveredStatus: out.delivered.status, usedAfterSuccess: out.afterSuccess.total_used }));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
