#!/usr/bin/env node
/**
 * READ-ONLY pre-deployment check for the Payhip default-deny mapping.
 *
 * The webhook used to guess the edition from the product NAME and PRICE and default everything else to "Digital Companion".
 * It now accepts only explicitly known products, identified the way Payhip documents it: items[].product_key (the short code
 * in the product URL) or product_permalink. Two checks, both read-only:
 *
 *   1. CATALOGUE SELF-TEST  - takes the Payhip ids configured in the product records (ebooks.access_options: the edition id and
 *      the upgrade id of every edition), builds an event in the exact shape Payhip documents, and verifies the mapper returns
 *      the tier each id is configured for. A mismatch means a configured product would be mis-granted or rejected.
 *   2. STORED ORDERS        - re-maps the webhook payloads stored with existing Payhip orders. Orders stored without a payload
 *      (older rows, or a database that dropped the column) cannot be judged and are reported as UNVERIFIABLE, not rejected.
 *
 *   node server/scripts/verify-payhip-mapping.js [--limit 500]
 *
 * Exit code: 0 = all good, 3 = the self-test failed or a stored payload would be rejected.
 * It only SELECTs. It prints product ids / keys, names, prices and counts, never e-mail addresses, tokens or secrets.
 */
'use strict';

const UNVERIFIABLE = 'UNVERIFIABLE (no stored payload)';

function signatureOf(order) {
    const items = order?.raw_metadata?.payhip_payload?.items;
    const first = Array.isArray(items) && items.length ? items[0] : null;
    if (first) return { item: first, source: 'stored payload', verifiable: true };
    return { item: { product_name: order.book_name || '', price: Math.round(Number(order.amount || 0) * 100) }, source: 'stored title/amount only', verifiable: false };
}

function keyOf(item) {
    return item.product_key || (String(item.product_permalink || item.product_link || '').match(/\/b\/([A-Za-z0-9]+)/) || [])[1] || '-';
}

function analyse(orders, mapFn) {
    const groups = new Map();
    for (const order of orders) {
        const { item, source, verifiable } = signatureOf(order);
        const mapped = verifiable ? mapFn(item, {}) : null;
        const key = JSON.stringify([item.product_id || '', keyOf(item), String(item.product_name || '').slice(0, 60), item.price || '', source]);
        const g = groups.get(key) || {
            product_id: item.product_id || '-', product_key: keyOf(item), link_key: keyOf(item), name: String(item.product_name || '-').slice(0, 60),
            price: item.price || '-', source, orders: 0, storedTiers: new Set(), mismatch: false,
            result: !verifiable ? UNVERIFIABLE : (mapped ? `${mapped.accessTier}${mapped.isUpgrade ? ' (upgrade)' : ''}` : 'REJECT'),
        };
        g.orders += 1;
        if (order.access_tier) g.storedTiers.add(order.access_tier);
        if (mapped && order.access_tier && order.access_tier !== mapped.accessTier) g.mismatch = true;
        groups.set(key, g);
    }
    return [...groups.values()];
}

/** options come from ebooks.access_options. Returns one row per configured Payhip id. */
function catalogueSelfTest(ebooks, mapFn) {
    const rows = [];
    for (const book of ebooks || []) {
        let options = book.access_options;
        if (typeof options === 'string') { try { options = JSON.parse(options); } catch { options = []; } }
        for (const opt of Array.isArray(options) ? options : []) {
            const tier = opt.access_type === 'online' ? 'online' : 'companion';
            const checks = [];
            if (opt.payhip_product_id) checks.push({ id: String(opt.payhip_product_id), kind: 'edition', want: tier, wantUpgrade: false });
            if (opt.upgrade_payhip_product_id) checks.push({ id: String(opt.upgrade_payhip_product_id), kind: 'upgrade', want: 'companion', wantUpgrade: true });
            for (const c of checks) {
                // the shape Payhip documents for items[] (the numeric product_id is irrelevant to the match, so a dummy is used)
                const item = { product_id: '0', product_name: opt.name || '-', product_key: c.id, product_permalink: `https://payhip.com/b/${c.id}`, quantity: '1' };
                const mapped = mapFn(item, {});
                const got = mapped ? mapped.accessTier : null;
                const gotUp = mapped ? Boolean(mapped.isUpgrade) : false;
                rows.push({ product: String(book.title || '').slice(0, 34), edition: String(opt.name || '').slice(0, 40), kind: c.kind, id: c.id, wantTier: c.want, wantUpgrade: c.wantUpgrade, gotTier: got, gotUpgrade: gotUp, ok: got === c.want && gotUp === c.wantUpgrade });
            }
        }
    }
    return rows;
}

async function main(argv) {
    const limitArg = argv.indexOf('--limit');
    const limit = limitArg > -1 ? Math.max(1, parseInt(argv[limitArg + 1], 10) || 500) : 500;

    require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
    const supabase = require('../config/supabaseClient');
    const { mapPayhipProductToBook, resolvePayhipProductMapping } = require('../utils/payhipVerifier');
    let exitCode = 0;

    // ---- 1. catalogue self-test
    const cat = await supabase.from('ebooks').select('id, title, access_options');
    if (cat.error) { console.error('Could not read the product catalogue:', cat.error.message); return 1; }
    const selfRows = catalogueSelfTest(cat.data, mapPayhipProductToBook);
    console.log('1. CATALOGUE SELF-TEST (ids configured in the product records, mapped as a Payhip event would be)');
    console.log('   product                            edition                          kind     payhip id   expected          got');
    for (const r of selfRows) console.log(`   ${r.product.padEnd(34)} ${r.edition.padEnd(32)} ${r.kind.padEnd(8)} ${r.id.padEnd(10)}  ${(r.wantTier + (r.wantUpgrade ? ' (upgrade)' : '')).padEnd(17)} ${r.gotTier ? r.gotTier + (r.gotUpgrade ? ' (upgrade)' : '') : 'REJECT'}  ${r.ok ? 'OK' : '<-- MISMATCH'}`);
    if (!selfRows.length) console.log('   (no Payhip ids are configured in the catalogue)');
    if (selfRows.some((r) => !r.ok)) exitCode = 3;
    // the DB-aware resolver the webhook really calls must agree with the synchronous mapper for these ids
    for (const r of selfRows) {
        const viaDb = await resolvePayhipProductMapping({ product_id: '0', product_key: r.id, product_permalink: `https://payhip.com/b/${r.id}`, product_name: r.edition, quantity: '1' }, {});
        if (!viaDb || viaDb.accessTier !== r.wantTier) { console.log(`   !! the webhook resolver disagrees for ${r.id}: ${viaDb ? viaDb.accessTier : 'REJECT'}`); exitCode = 3; }
    }

    // ---- 2. stored orders
    const { data, error } = await supabase.from('orders').select('id, book_name, amount, access_tier, is_upgrade, raw_metadata, created_at')
        .eq('payment_provider', 'payhip').order('created_at', { ascending: false }).limit(limit);
    if (error) { console.error('Query failed:', error.message); return 1; }
    const groups = analyse(data || [], mapPayhipProductToBook);
    console.log(`\n2. STORED PAYHIP ORDERS examined: ${(data || []).length}`);
    console.log('   orders  result                              stored tier   product key   name  [price cents]  (source)');
    for (const g of groups.sort((a, b) => b.orders - a.orders)) console.log(`   ${String(g.orders).padStart(6)}  ${g.result.padEnd(34)}  ${([...g.storedTiers].join(',') || '-').padEnd(12)}  ${String(g.product_key).padEnd(12)}  ${g.name}  [${g.price}]  (${g.source})${g.mismatch ? '   <-- tier differs from what was granted' : ''}`);
    const rejected = groups.filter((g) => g.result === 'REJECT');
    const unverifiable = groups.filter((g) => g.result === UNVERIFIABLE).reduce((n, g) => n + g.orders, 0);
    if (unverifiable) console.log(`\n   ${unverifiable} order(s) were stored without the webhook payload, so they cannot be re-checked. That is a limit of the stored data, not a finding.`);
    if (rejected.length) { console.log(`\n   ${rejected.reduce((n, g) => n + g.orders, 0)} stored payload(s) would be REJECTED by the current rules. Fix the configuration before deploying.`); exitCode = 3; }
    console.log(exitCode === 0 ? '\nRESULT: OK - every configured Payhip id maps to the tier it is configured for' + (rejected.length ? '' : ', and no stored payload would be rejected.') : '\nRESULT: PROBLEMS FOUND (see above)');
    return exitCode;
}

if (require.main === module) {
    main(process.argv).then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}

module.exports = { analyse, signatureOf, catalogueSelfTest, keyOf, UNVERIFIABLE };
