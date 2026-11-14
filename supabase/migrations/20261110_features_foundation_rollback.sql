-- Rollback of 20261110_features_foundation.sql. Drops ONLY the objects that migration created, in reverse dependency order.
-- WARNING: this deletes entitlement, audit and usage history created after the migration. Export those tables first
-- (see the deployment notes) if any real customer data exists. No pre-existing table is touched.
DROP FUNCTION IF EXISTS public.search_knowledge(text, text[], integer, text);
DROP FUNCTION IF EXISTS public.reorder_reader_chapters(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.admin_entitlement_action(uuid, text, integer, text, uuid, text);
DROP FUNCTION IF EXISTS public.ask_sid_allowance(uuid);
DROP FUNCTION IF EXISTS public.release_ask_sid_question(uuid);
DROP FUNCTION IF EXISTS public.commit_ask_sid_question(uuid);
DROP FUNCTION IF EXISTS public.reserve_ask_sid_question(text, uuid, text);
DROP FUNCTION IF EXISTS public.get_active_entitlement(text, text);
DROP FUNCTION IF EXISTS public.revoke_entitlement_for_order(uuid, text);
DROP FUNCTION IF EXISTS public.grant_entitlement_for_order(uuid, text, uuid, text, boolean, timestamptz, text);
DROP FUNCTION IF EXISTS public.feat_log(uuid, text, uuid, text, jsonb, uuid, text);
DROP FUNCTION IF EXISTS public.feat_limits();
DROP TABLE IF EXISTS public.admin_audit_log;
DROP TABLE IF EXISTS public.knowledge_chunks;
DROP TABLE IF EXISTS public.companion_files;
DROP TABLE IF EXISTS public.webhook_events;
DROP TABLE IF EXISTS public.ask_sid_usage;
DROP TABLE IF EXISTS public.entitlement_events;
DROP TABLE IF EXISTS public.launch_allocations;
DROP TABLE IF EXISTS public.user_entitlements;
DROP TABLE IF EXISTS public.reading_progress;
DROP TABLE IF EXISTS public.reader_chapters;
DROP TABLE IF EXISTS public.reader_books;
DROP TABLE IF EXISTS public.entitlement_settings;
DROP FUNCTION IF EXISTS public.feat_events_immutable();
DROP FUNCTION IF EXISTS public.feat_norm_email(text);
DROP FUNCTION IF EXISTS public.feat_set_updated_at();
