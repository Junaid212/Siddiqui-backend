# Siddiqui.digital - production runbook (state of 2026-11-14)

The same file is kept in all three repositories. It lists everything that is NOT in the code itself, so the system can be rebuilt
from GitHub. It contains no secrets: the names of the settings are listed, the values live only in the `.env` files on the server
(and in the owner's password manager).

## 1. The three parts

| Part | GitHub repo | On the VPS | Process |
|---|---|---|---|
| Public website (React + Vite, pre-rendered pages) | `junaid212/siddiui.digital` | built locally, served from `/var/www/frontend` by nginx | none (static files) |
| Customer backend (Express) | `Junaid212/Siddiqui-backend` | `/root/project/backend` | PM2 `siddiqui-backend` |
| Admin (Express + React) | `Junaid212/Sidiiqui-admin` | `/root/project/admin` (server) and `/var/www/admin` (built client) | PM2 `admin-backend` |

Database and login: ONE production Supabase project, `cneariiepqywvjpmznqn`. A separate staging project `xnqcdwenfomhnfykmvra`
exists for tests. Never mix them up. Payments: Payhip only (the Payhip account belongs to the client).

Git: branch `feature/companion-pack-reader-updates` holds the current work. Tag `live-2026-11-14` (public repo) marks exactly what was
deployed on that day; the commit after the tag contains edits that were not deployed yet.

## 2. Settings (names only)

Public site, build time (`.env`, `.env.production`; not in git): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (publishable key),
`VITE_ADMIN_API_URL`, `VITE_PAYHIP_COMPANION_PRODUCT_ID/_URL`, `VITE_PAYHIP_ONLINE_PRODUCT_ID/_URL`, `VITE_PAYHIP_UPGRADE_PRODUCT_ID/_URL`.
`.env.example` shows the shape. The key in the build decides which Supabase key the live site uses.

Backend (`/root/project/backend/.env`): `PORT`, `FRONTEND_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`SMTP_*`, `ADMIN_EMAIL`, `PAYHIP_API_KEY` (the webhook is verified with sha256 of it), `ACCESS_LINK_SECRET`, `MR_PRODUCT_ID`,
optional `PAYHIP_*_PRODUCT_ID`, `PAYHIP_MAPPING_JSON`.

Admin server (`/root/project/admin/server/.env`): `PORT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SMTP_*`,
`ADMIN_EMAIL`, `FRONTEND_URL`/`CLIENT_URL`, optional `PUBLIC_SITE_ROOT`, `PRERENDER_SWEEP_MINUTES`, `OFFER_BANNER_FILE`.

## 3. Database (Supabase SQL editor, in this order, once)

1. The older files in `supabase/migrations` of each repo (orders, ebooks, blogs ...), if building a new project.
2. `20261110_features_foundation.sql` (reader, Ask SID, entitlements, companion files). Rollback: `..._rollback.sql`.
3. Administrator accounts need `app_metadata.role = 'admin'` on `auth.users` (the dashboard cannot edit it: use SQL, and verify with a
   select, because the editor says "Success" even when 0 rows changed). Current admins: info@siddiqui.digital, mqs@siddiqui.digital.

## 4. Deploy / update

Public site: `npm ci && npm run build` (vite build + the two pre-render scripts) with the right `.env` files, then copy `dist/` to
`/var/www/frontend`. Do not build from a different source than the tagged state, or the SEO pages change. The favicon is part of `public/`.

Backend and admin: copy the changed files to the VPS, `npm ci` if `package.json` changed, restart PM2 (`pm2 restart siddiqui-backend`
/ `admin-backend`). Admin client: `cd client && npm run build && cp -a dist/. /var/www/admin/`. Take a copy of the old folder first
(`cp -a /var/www/admin /var/www/admin.bak-DATE`).

Safe-install tool used for rollouts: `rollout-apply.cjs <package.tar.gz> <project> <backup-folder> [--apply|--undo]` (report-only by default).

## 5. Payhip

Webhook URL: `https://siddiqui.digital/api/payment/payhip/webhook` (also `/api/webhooks/payhip`). Product keys: Online Reading `Nr3Tp`,
Digital Companion `2H0Wr`, Upgrade `IpN7k`. The coupon (LAUNCH30) is created in Payhip; its end date is set there.

## 6. Features and rules worth knowing

- Online Reading: reader only. Digital Companion: PDF download + Ask SID (5 questions/day, 100 total, 12 months; 150 for the first 200
  launch buyers). Upgrade ends Online and starts 12 months from the upgrade date. A full refund removes access.
- The launch-offer counter is CLOSED until it is opened in the admin on launch day. Do not run `sync-entitlements` for old test orders.
- Ask SID answers only from PUBLISHED chapters of a PUBLISHED book (admin > Online Reading; the page shows what Ask SID is reading).
  With no published book it falls back to the old built-in knowledge.
- Companion PDF: admin > Companion Files (upload, make current, delete). The current file is what customers download.
- Offer banner and the "Get Digital Companion" button: admin > Digital Products > Launch offer card. Its settings file
  (`server/src/data/offer_banner.json` on the VPS) is live data and is deliberately not in git.

## 7. Server configuration that lives outside git

- nginx: site file `/etc/nginx/sites-enabled/siddiqui.digital` and snippet `/etc/nginx/snippets/siddiqui-perf.conf` (gzip, 1-year
  immutable hashed assets, 7-day images, no-cache html). A copy is kept in `infra/` of the backend repo when it has been added.
- PM2 process list: `pm2 save` after changes; `pm2 startup` is configured.
- SMTP settings for order e-mails; DNS and TLS certificates (Let's Encrypt).

## 8. Open items (as of 2026-11-14)

- Swap the live site to the production publishable key and disable the legacy Supabase keys LAST.
- Real book chapters and the real Companion PDF are added by the client in the admin.
- Terms / Privacy / Refund pages still mention PayPal and Stripe.
