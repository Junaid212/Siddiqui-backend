/**
 * couponScope.js - which products a coupon applies to ("Applies to").
 * A coupon's applies_to is a list of keys; an empty / missing list means ALL products.
 *   companion        the Digital Companion Edition (also the Upgrade, which is the Companion at a difference price)
 *   online           the Online Reading Edition
 *   other            every other book / framework / download
 *   product:<uuid>   one specific product (any edition)
 * The same rules are used by the admin server, the customer backend and the website cart, so a restricted coupon behaves the same everywhere.
 */
const KEY_RE = /^(companion|online|other|product:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const LABELS = { companion: 'Digital Companion Edition', online: 'Online Reading Edition', other: 'other books and frameworks' };

/** Clean what an administrator sent: known keys only, no duplicates; "all" or nothing -> [] (all products). */
function cleanAppliesTo(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const raw of input) {
        const k = String(raw || '').trim();
        if (!KEY_RE.test(k)) continue;
        const key = /^product:/i.test(k) ? 'product:' + k.slice(8).toLowerCase() : k.toLowerCase();
        if (!out.includes(key)) out.push(key);
    }
    return out;
}

/** The scope key of a cart item (accessType: online | companion | upgrade | anything else). */
function itemKey(item) {
    const t = String((item && (item.accessType || item.access_type || item.edition)) || '').toLowerCase();
    if (t === 'companion' || t === 'upgrade') return 'companion';
    if (t === 'online') return 'online';
    return 'other';
}

function itemMatches(appliesTo, item) {
    if (!Array.isArray(appliesTo) || appliesTo.length === 0) return true;
    const pid = String((item && (item.productId || item.product_id)) || '').toLowerCase();
    return appliesTo.includes(itemKey(item)) || (pid && appliesTo.includes('product:' + pid));
}

/** "Digital Companion Edition", "Digital Companion Edition and Online Reading Edition", ... (a specific product is shown as "selected products"). */
function appliesToLabel(appliesTo) {
    const names = [];
    for (const k of appliesTo || []) { if (LABELS[k]) names.push(LABELS[k]); else if (/^product:/.test(k) && !names.includes('selected products')) names.push('selected products'); }
    return names.length ? names.join(' and ') : 'all products';
}

/** true when at least one cart item is covered. A restricted coupon with NO items given cannot be confirmed, so it is refused. */
function couponCoversItems(appliesTo, items) {
    if (!Array.isArray(appliesTo) || appliesTo.length === 0) return true;
    return Array.isArray(items) && items.some((it) => itemMatches(appliesTo, it));
}

module.exports = { cleanAppliesTo, itemKey, itemMatches, appliesToLabel, couponCoversItems, KEY_RE };
