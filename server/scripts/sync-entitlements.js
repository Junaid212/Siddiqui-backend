#!/usr/bin/env node
/**
 * sync-entitlements.js - creates entitlements from the EXISTING orders (the same idempotent rules the live webhook uses).
 *   node scripts/sync-entitlements.js                      # dry run: lists every order and what would happen
 *   node scripts/sync-entitlements.js --apply              # writes
 *   node scripts/sync-entitlements.js --apply --email a@b  # only one customer
 * Launch positions are only allocated if the owner has opened the launch offer (entitlement_settings.ask_sid_limits.launch_starts_at);
 * until then older and test orders can never take one of the 200 positions. Production use needs owner approval.
 */
const supabase = require("../config/supabaseClient");
const ent = require("../utils/entitlements");
const apply = process.argv.includes("--apply");
const only = (() => { const i = process.argv.indexOf("--email"); return i > 0 ? ent.normalizeEmail(process.argv[i + 1]) : null; })();
const mask = (e) => String(e).replace(/^(.).*(@.*)$/, "$1***$2");

(async () => {
  let q = supabase.from("orders").select("*").order("created_at", { ascending: true }).limit(5000);
  if (only) q = q.ilike("email", ent.escapeLike(only));
  const { data: orders, error } = await q;
  if (error) { console.error("Could not read orders:", error.message); process.exit(1); }
  const tally = {};
  for (const o of orders) {
    const plan = !ent.isCatalogOrder(o) ? "skip (not Marketing Reclassified)" : ent.isRefundedOrder(o) ? "revoke (refunded)" : ent.isPaidOrder(o) ? `grant ${ent.editionFromOrder(o)}${o.is_upgrade ? " (upgrade)" : ""}` : `skip (status ${o.status})`;
    console.log(`${String(o.created_at).slice(0, 10)}  ${mask(o.email || "")}  ${String(o.order_number || o.id).slice(0, 28).padEnd(28)}  ${plan}`);
    tally[plan] = (tally[plan] || 0) + 1;
    if (apply && !/^skip/.test(plan)) { const r = await ent.syncOrderEntitlement(o); if (!r.ok) console.log("   FAILED:", r.error || r.skipped); }
  }
  console.log("\nSummary:", tally, apply ? "(applied)" : "(dry run - nothing written; add --apply)");
})();
