# Online Reading, Digital Companion, Ask SID and entitlements (v4)

This document describes how the features fit together. Everything sits on top of the Stage 0 security patches.

## The rule that drives everything
A customer has **at most one active entitlement** per book:

| | Online reader | Companion downloads | Ask SID |
|---|:-:|:-:|:-:|
| Online Reading edition | yes | no | no (upgrade message) |
| Digital Companion edition | **no** | yes | yes (5/day, 100 total; 150 for the first 200) |
| Upgrade (Online -> Companion) | revoked | yes | yes (12 months start on the upgrade date) |

The matrix lives in one place (`server/utils/entitlements.js`, `PERMISSIONS`). The database enforces the invariants that must never be
wrong: a unique index allows only one active entitlement per customer, so Online and Companion can never both be active.

## Where entitlements come from
Entitlements are a **projection of PAID orders**, never of anything the browser says:
* Payhip `paid` webhook -> `grant_entitlement_for_order` (idempotent per order). `refunded` (full) -> `revoke_entitlement_for_order`.
* Admin dashboard "Refund" button -> same revoke.
* Every access check also looks at the entitlement's source order: if it is refunded the entitlement is revoked on the spot, whatever path changed it.
* A customer with no entitlement yet (PayPal / Stripe order, missed webhook) is repaired the first time they use a feature (their own orders are replayed, idempotently). An Online customer is re-checked (at most every 30 s) so an upgrade through any channel is noticed.
* Payhip "claim your purchase" moves the entitlement to the new account.

## Database (`supabase/migrations/20261110_features_foundation.sql`)
Purely additive and idempotent; nothing existing is altered. 12 new tables, RLS enabled on all with **no client policy** (only the backend's
secret key can touch them), all functions executable by `service_role` only.

| Table | Purpose |
|---|---|
| `reader_books`, `reader_chapters` | Online Reading content (draft / published / unpublished, ordered) |
| `reading_progress` | where each reader stopped |
| `user_entitlements` | the single source of truth for access (edition, dates, limits, launch position, revocation reason) |
| `launch_allocations` | immutable record of launch positions 1..200 (a refund never frees one) |
| `entitlement_events`, `admin_audit_log` | append-only history |
| `ask_sid_usage` | one row per question: reserved -> committed / released |
| `webhook_events` | delivery log (identifiers only, no personal data) |
| `companion_files`, `knowledge_chunks` | Companion PDF versions and the searchable passages (book + Companion) |
| `entitlement_settings` | limits (5 / 100 / 150 / 12 months / 200) and the launch-offer start |

Functions: `grant_entitlement_for_order`, `revoke_entitlement_for_order`, `get_active_entitlement`, `reserve/commit/release_ask_sid_question`,
`ask_sid_allowance`, `admin_entitlement_action`, `reorder_reader_chapters`, `search_knowledge`.

### The launch offer starts CLOSED
`launch_starts_at` is seeded as `9999-12-31`. Until the owner opens it (dashboard -> Reader & Companion Customers -> "Open the launch offer"),
no purchase can take one of the 200 positions. Reason: production holds test orders from 26 Oct; positions can never be re-assigned.
Positions are handed out in the order purchases are processed (normally at payment time) under a global lock.

### Ask SID counting
A question is **reserved** (all checks under a row lock), answered, then **committed** only if an answer was delivered. Rejected, out-of-scope
or failed requests are **released** and cost nothing. A reservation that was never finished stops counting after 2 minutes. The daily counter
resets at 00:00 UTC. Limits: daily 5; total 100, or 150 for launch positions 1..200; access ends 12 months after the purchase / upgrade date.

## Ask SID retrieval
One search over `knowledge_chunks` (PostgreSQL full-text) with two sources: `book` (published reader chapters, indexed automatically when
published/edited/unpublished, plus the legacy `marketingReclassified.js` passages loaded by `scripts/seed-book-knowledge.js`) and `companion`
(the current Companion PDF, only for Companion customers). Answers are **extractive**: assembled from sentences that exist in the retrieved
passage, ~150 words maximum, naming the concept and chapter. If the question's meaningful words are not covered by the book, the fixed sentence
is returned: "Ask SID covers the ideas in Marketing Reclassified. Please ask about a concept from the book." No external knowledge, no web, no
links, no memory between sessions (only the current conversation sent with the request is used).
The previous controller is kept as `askSidLegacyController.js` and is used automatically until the migration and a book index exist.

## Admin dashboard (new pages)
* **Online Reading**: books and chapters, rich-text editor, "Edit HTML" mode (for tables), import a book from a Word file (each Heading 1 = a draft chapter), preview drafts, publish / unpublish, reorder, delete with confirmation. HTML is sanitised on the server.
* **Companion Files**: upload a PDF (checked by content), see processing/indexing status, errors, retry; a new version becomes the download only after it was indexed; older versions can be made current again.
* **Reader & Companion Customers**: filter by edition / upgraded / refunded, search, per-customer history (original purchase + upgrade), expiry, launch position, daily/total usage and remaining allowance, corrections with a mandatory reason, webhook deliveries (failures highlighted), audit log, launch-offer control.

## Deployment safety
* The new backend code works **before** the migration (feature calls answer "not installed yet" and the old behaviour continues: downloads under the old rules, legacy Ask SID, reader says "coming soon"), so the order of deployment is not fragile.
* New npm dependency: admin server `pdfjs-dist@3.11.174` (run `npm install` in `server/`). No new dependency in the other projects.
* Rollback: `20261110_features_foundation_rollback.sql` drops only the objects it created (export the new tables first if real customer data exists); the code can be reverted with `git apply -R`.
