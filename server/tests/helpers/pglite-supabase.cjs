/**
 * Test-only. A small supabase-js look-alike backed by a REAL PostgreSQL engine (PGlite = Postgres compiled to WASM) that
 * has the feature migration applied. It lets the HTTP-level tests exercise the real SQL functions (entitlement engine,
 * launch allocation, quota) instead of re-implementing them in JavaScript.
 *   const pg = await createPgSupabase({ migrationPath, launchOpen: true });
 *   pg.rpc('fn', { p_x: 1 })      -> { data, error }
 *   pg.from('table').select().eq('col', v).order('c').limit(5).maybeSingle()
 * Supports: select(cols|count/head), insert, update, delete, upsert(onConflict), eq/neq/in/is/ilike/gt/gte/lt/lte,
 * order, limit, range, single, maybeSingle, returning rows after insert/update (select()).
 */
'use strict';
const fs = require('fs');
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT.test(s)) throw new Error('bad identifier ' + s); return '"' + s + '"'; };
const val = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v); // arrays stay arrays (text[] / uuid[] arguments)

class PgQuery {
  constructor(pg, table) { this.pg = pg; this.table = table; this.op = 'select'; this.cols = '*'; this.where = []; this.params = []; this.orders = []; this.lim = null; this.off = null; this.mode = 'many'; this.countMode = null; this.head = false; this.ret = false; }
  select(cols, opts) { this.cols = cols || '*'; if (this.op !== 'select') this.ret = true; if (opts && opts.count) this.countMode = opts.count; if (opts && opts.head) this.head = true; return this; }
  insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, o = {}) { this.op = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; this.onConflict = o.onConflict; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  _f(c, op, v) { this.params.push(val(v)); this.where.push(`${ident(c)} ${op} $${this.params.length}`); return this; }
  eq(c, v) { return this._f(c, '=', v); }
  neq(c, v) { return this._f(c, '<>', v); }
  gt(c, v) { return this._f(c, '>', v); }
  gte(c, v) { return this._f(c, '>=', v); }
  lt(c, v) { return this._f(c, '<', v); }
  lte(c, v) { return this._f(c, '<=', v); }
  ilike(c, v) { return this._f(c, 'ILIKE', v); }
  is(c, v) { this.where.push(`${ident(c)} IS ${v === null ? 'NULL' : v ? 'TRUE' : 'FALSE'}`); return this; }
  in(c, arr) { const ph = arr.map((v) => { this.params.push(val(v)); return '$' + this.params.length; }); this.where.push(ph.length ? `${ident(c)} IN (${ph.join(',')})` : 'FALSE'); return this; }
  order(c, o) { this.orders.push(`${ident(c)} ${o && o.ascending === false ? 'DESC' : 'ASC'}`); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  _w() { return this.where.length ? ' WHERE ' + this.where.join(' AND ') : ''; }
  _cols() { return this.cols === '*' ? '*' : String(this.cols).split(',').map((c) => ident(c.trim())).join(', '); }
  async exec() {
    await this.pg.ready;
    try {
      let sql; let count = null;
      const t = ident(this.table);
      if (this.op === 'select') {
        if (this.countMode) count = Number((await this.pg.db.query(`SELECT count(*)::int n FROM public.${t}${this._w()}`, this.params)).rows[0].n);
        if (this.head) return { data: null, error: null, count };
        sql = `SELECT ${this._cols()} FROM public.${t}${this._w()}${this.orders.length ? ' ORDER BY ' + this.orders.join(', ') : ''}${this.lim != null ? ' LIMIT ' + Number(this.lim) : ''}${this.off ? ' OFFSET ' + Number(this.off) : ''}`;
      } else if (this.op === 'insert' || this.op === 'upsert') {
        const keys = [...new Set(this.rows.flatMap((r) => Object.keys(r)))];
        const params = []; const tuples = this.rows.map((r) => '(' + keys.map((k) => { params.push(val(r[k] === undefined ? null : r[k])); return '$' + params.length; }).join(',') + ')');
        sql = `INSERT INTO public.${t} (${keys.map(ident).join(',')}) VALUES ${tuples.join(',')}`;
        if (this.op === 'upsert') { const oc = (this.onConflict || 'id').split(',').map((c) => ident(c.trim())).join(','); sql += ` ON CONFLICT (${oc}) DO UPDATE SET ${keys.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ')}`; }
        sql += this.ret ? ` RETURNING ${this._cols()}` : '';
        this.params = params;
      } else if (this.op === 'update') {
        const ks = Object.keys(this.patch); const base = this.params.length;
        const sets = ks.map((k, i) => `${ident(k)} = $${base + i + 1}`);
        sql = `UPDATE public.${t} SET ${sets.join(', ')}${this._w()}${this.ret ? ` RETURNING ${this._cols()}` : ''}`;
        this.params = [...this.params, ...ks.map((k) => val(this.patch[k]))];
      } else sql = `DELETE FROM public.${t}${this._w()}${this.ret ? ` RETURNING ${this._cols()}` : ''}`;
      const res = await this.pg.db.query(sql, this.params);
      const rows = res.rows;
      if (this.mode === 'single') { if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'expected one row' } }; return { data: rows[0], error: null }; }
      if (this.mode === 'maybe') return { data: rows[0] || null, error: null };
      return { data: this.op === 'select' || this.ret ? rows : null, error: null, count };
    } catch (e) { return { data: null, error: { code: e.code || 'XX000', message: e.message } }; }
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
}

function createPgSupabase({ migrationPath, launchOpen = true, pglite, seedSql }) {
  const pg = { db: null };
  pg.ready = (async () => {
    const { PGlite } = pglite || require('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;');
    await db.exec(fs.readFileSync(migrationPath, 'utf8'));
    if (launchOpen) await db.exec("UPDATE public.entitlement_settings SET value = jsonb_set(value,'{launch_starts_at}','\"2000-01-01T00:00:00Z\"') WHERE key='ask_sid_limits'");
    if (seedSql) await db.exec(fs.readFileSync(seedSql, 'utf8'));
    pg.db = db;
  })();
  pg.from = (t) => new PgQuery(pg, t);
  pg.rpc = async (fn, args = {}) => {
    await pg.ready;
    try {
      const names = Object.keys(args); const params = names.map((n) => val(args[n]));
      const call = names.length ? names.map((n, i) => `${ident(n)} => $${i + 1}`).join(', ') : '';
      const meta = await pg.db.query("SELECT bool_or(proretset) AS setof FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace", [fn]);
      if (meta.rows[0].setof) { // a function returning a table answers with an ARRAY of rows, like PostgREST
        const r = await pg.db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS r FROM public.${ident(fn)}(${call}) t`, params);
        return { data: r.rows[0].r, error: null };
      }
      const r = await pg.db.query(`SELECT to_jsonb(public.${ident(fn)}(${call})) AS r`, params);
      return { data: r.rows[0].r, error: null };
    } catch (e) { return { data: null, error: { code: /does not exist/.test(e.message) ? '42883' : (e.code || 'XX000'), message: e.message } }; }
  };
  return pg;
}
module.exports = { createPgSupabase, PgQuery };
