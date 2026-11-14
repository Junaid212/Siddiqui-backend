# Stage 0 security patch — customer backend notes (v3)

This patch changes **no database schema and no production data**. It is code only. It needs **no new environment variable**
(optional ones are listed at the end).

## What changed (customer API)

| Issue | Fix | Where |
|---|---|---|
| Order history readable by e-mail alone, including download tokens | `GET /api/payment/my-orders` and `/check-ownership` require a signed-in, e-mail-confirmed Supabase session. The customer is identified by the session; any `?email=` is ignored. `check-ownership` no longer returns raw order rows and no longer counts refunded orders as owned. | `utils/requireCustomer.js`, `routes/paymentRoutes.js`, `controllers/cartController.js` |
| My Orders listed reusable credentials (download token, provider ids) | The list carries display fields only. Downloads and the online reader are reached through **short-lived (120 s), order-bound, purpose-bound signed links** issued by `POST /api/payment/orders/:id/access-link` to the owner only (other customers get 404). Every rule (payment status, refund, edition, expiry, download limit) is re-checked when the link is used. | `utils/accessLinks.js`, `controllers/paymentController.js` (`createAccessLink`, `serveAccessLink`) |
| Order numbers / provider transaction ids unlocked files | A legacy `/download/:x` or `/read/:x` link is honoured only if the value IS that order's own token, Stripe session id or UUID. A value that merely matched an order number, Payhip/PayPal id is refused (404). The rule checks which field matched, so older token formats keep working. | `controllers/paymentController.js` (`credentialMatchesOrder`) |
| Replacement-link request used `%`/`_` wildcards and unescaped filter text | E-mail must be well-formed and is matched literally; the order number is reduced to `[A-Za-z0-9_-]`; the link goes to the address stored on the order. | `controllers/paymentController.js` |
| Unknown Payhip product became "Digital Companion" (name/price guessing) | Default-deny: only explicitly known products are accepted; anything else returns HTTP 422 and nothing is granted (a mixed payment is rejected as a whole). | `utils/payhipVerifier.js`, `controllers/payhipController.js` |
| Products must be recognised the way Payhip really identifies them | Payhip's documented webhook (help article 115) sends, per item, `product_key` (the short code in the product URL) and `product_permalink` as well as a numeric `product_id`. The mapper matches the configured keys `Nr3Tp` (Online Reading), `2H0Wr` (Digital Companion), `IpN7k` (Upgrade) and also honours `used_upgrade_discount`. Extra numeric ids can be added with `PAYHIP_*_PRODUCT_ID` (comma lists). **The numeric id `2804256` in the repository's simulation scripts is Payhip's documentation example and is deliberately NOT allowed.** | `utils/payhipVerifier.js` |
| A rejected product could be a real sale that silently grants nothing | The owner is e-mailed once per product per 6 hours (transaction id, product id/name/price only; no customer data). Nothing was stored, so the event can be re-delivered after the id is configured. | `controllers/payhipController.js` (`notifyUnsupportedProduct`) |
| Duplicate / simultaneous webhook deliveries | Events for one transaction are processed one at a time: a promise queue per process **plus an atomic directory lock shared by all processes on the server**. Idempotency is item-aware; a failed insert returns 500 (Payhip retries) instead of "received". | `controllers/payhipController.js`, `utils/fileLock.js` |
| Refunds did not reliably revoke access | Download, reader, access links and order-status deny `status = refunded` **or** `refund_status = refunded/full`; a refund that arrives before its payment is remembered so a late payment cannot grant access. (Admin refund button: see the admin patch.) | `controllers/paymentController.js`, `controllers/payhipController.js` |

## Known limits (to be closed in later stages)

* **Duplicate protection covers one server.** Several processes on the same machine are safe (tested with two real processes
  sharing a database and the lock directory: 0 duplicates in 300 simultaneous deliveries; the previous single-process lock
  produced duplicates under the same load). Several *servers* sharing one database still need the unique index below.
* The "refund before payment" marker lives in the order metadata file (`ORDERS_METADATA_PATH`, default OS temp dir); it does
  not survive a reboot or temp cleanup. Stage 1 replaces it with the `webhook_logs` table.
* **The order UUID is still accepted as a legacy credential** (random, 122 bits) because the post-purchase page and some e-mails
  use it. It is no longer listed together with a token and is not needed by My Orders. Stage 2 replaces legacy links with
  entitlement checks.
* Emailed download links (random token, 72 h, 3 downloads) are unchanged: they are the guest-purchase flow.
* The Payhip mapper still marks Companion as `canReadOnline: true` and the online reader does not check the edition (Stage 2/3).
* Payhip retries a webhook that does not answer 200 once an hour for up to 3 hours, then gives up. A rejected (422) genuine sale therefore has about 3 hours to be fixed and re-delivered; the owner alert e-mail exists for exactly that. Run `verify-payhip-mapping.js` before deploying so a mis-configured id is found first.
  name/id/key matching.

## Database constraint required later (NOT applied by Stage 0)

Run only in the Stage 1 migration, after the duplicate check below returns no rows. Apply to staging first.

```sql
-- 1. Find existing duplicates (must return zero rows before creating the index)
SELECT payhip_transaction_id, product_id, is_upgrade, count(*)
FROM public.orders
WHERE payment_provider = 'payhip' AND payhip_transaction_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING count(*) > 1;

-- 2. Then (CONCURRENTLY: no table lock; cannot run inside a transaction block)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_orders_payhip_txn_product
  ON public.orders (payhip_transaction_id, product_id, is_upgrade)
  WHERE payment_provider = 'payhip' AND payhip_transaction_id IS NOT NULL;

-- Rollback
DROP INDEX CONCURRENTLY IF EXISTS public.uq_orders_payhip_txn_product;
```

The webhook already treats a unique-violation (`23505`) as "already processed", so the code is ready for the index.

## Optional environment variables (all have safe defaults)

| Variable | Purpose | Default |
|---|---|---|
| `ACCESS_LINK_SECRET` (>= 32 chars) | Signing key for access links | a key derived (HMAC) from `SUPABASE_SERVICE_ROLE`, stable across restarts and processes |
| `WEBHOOK_LOCK_DIR` | Directory for the cross-process lock | `<os tmp>/siddiqui-webhook-locks` (must be the same for all processes on the server) |
| `PAYHIP_COMPANION_PRODUCT_ID`, `PAYHIP_ONLINE_PRODUCT_ID`, `PAYHIP_UPGRADE_PRODUCT_ID` | Optional EXTRA Payhip ids (key or numeric product_id; comma lists allowed). Not needed for the configured products | empty |
| `ADMIN_EMAIL` | Receives the unrecognised-product alert | existing value |

## Before deploying: verify the product mapping (read-only)

```
node server/scripts/verify-payhip-mapping.js
```

It only reads (the product catalogue and the `orders` table) and prints product keys, names, prices and counts (no e-mail addresses, names, tokens or keys).
1. **Catalogue self-test** - for every Payhip id configured in the product records it builds an event in Payhip's documented shape and checks that the mapper
   returns the tier that id is configured for (Online Reading `Nr3Tp` -> online, Digital Companion `2H0Wr` -> companion, Upgrade `IpN7k` -> companion + upgrade).
2. **Stored orders** - re-maps stored webhook payloads; rows stored without a payload are reported UNVERIFIABLE (the production database stores none), not rejected.
Exit code 0 = OK; 3 = a configured id is mis-mapped or a stored payload would be rejected.

## Tests

```
node --test server/tests/*.test.cjs
```

The suite starts the real `server.js` (and, for the multi-process test, two copies of it) against in-memory fakes: no network,
database or e-mail.
