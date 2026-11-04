-- ============================================================================
-- Siddiqui.digital — Staging Foundation Rollback (Phase 1)
-- Target Staging Host: xnqcdwenfomhnfykmvra.supabase.co
-- Mode: Strictly Scoped, Reverse-Dependency Drop (No Broad CASCADE)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drop Table Triggers (Explicitly Cleaned Up Before Dropping Tables)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_coupons_updated_at ON public.coupons;
DROP TRIGGER IF EXISTS trg_blogs_updated_at ON public.blogs;
DROP TRIGGER IF EXISTS trg_consultations_updated_at ON public.consultations;
DROP TRIGGER IF EXISTS trg_sync_entitlement_expiration ON public.user_entitlements;
DROP TRIGGER IF EXISTS trg_user_entitlements_updated_at ON public.user_entitlements;
DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
DROP TRIGGER IF EXISTS trg_book_knowledge_nodes_updated_at ON public.book_knowledge_nodes;
DROP TRIGGER IF EXISTS trg_book_chapters_updated_at ON public.book_chapters;
DROP TRIGGER IF EXISTS trg_ebooks_updated_at ON public.ebooks;
DROP TRIGGER IF EXISTS trg_protect_profile_privilege_escalation ON public.profiles;
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;

-- ----------------------------------------------------------------------------
-- 2. Drop All 21 Foundation Tables in Strict Reverse-Dependency Order
-- Note: Dropped WITHOUT broad CASCADE so unmanaged external dependencies are
-- not accidentally deleted. Strict reverse order guarantees clean execution.
-- ----------------------------------------------------------------------------
-- Leaf tables (no foreign keys referencing these tables)
DROP TABLE IF EXISTS public.user_activity;
DROP TABLE IF EXISTS public.course_clicks;
DROP TABLE IF EXISTS public.contact_messages;
DROP TABLE IF EXISTS public.coupons;
DROP TABLE IF EXISTS public.blog_comments;
DROP TABLE IF EXISTS public.blogs;
DROP TABLE IF EXISTS public.questionnaire_submissions;
DROP TABLE IF EXISTS public.question_votes;
DROP TABLE IF EXISTS public.question_options;
DROP TABLE IF EXISTS public.questions;
DROP TABLE IF EXISTS public.consultations;
DROP TABLE IF EXISTS public.webhook_logs;
DROP TABLE IF EXISTS public.ask_sid_usage_logs;
DROP TABLE IF EXISTS public.ask_sid_settings;

-- Entitlements, cohort, and order tracking
DROP TABLE IF EXISTS public.first_200_cohort;
DROP TABLE IF EXISTS public.user_entitlements;
DROP TABLE IF EXISTS public.orders;

-- Book knowledge nodes, chapters, and publications
DROP TABLE IF EXISTS public.book_knowledge_nodes;
DROP TABLE IF EXISTS public.book_chapters;
DROP TABLE IF EXISTS public.ebooks;

-- User profile layer
DROP TABLE IF EXISTS public.profiles;

-- ----------------------------------------------------------------------------
-- 3. Drop Functions Created By Migration
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.consume_ask_sid_quota(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.allocate_first_200_companion(TEXT, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.link_user_entitlements();
DROP FUNCTION IF EXISTS public.sync_entitlement_expiration();
DROP FUNCTION IF EXISTS public.protect_profile_privilege_escalation();
DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.handle_updated_at();


-- ----------------------------------------------------------------------------
-- 4. Infrastructure & Extensions Note
-- ----------------------------------------------------------------------------
-- Extensions "uuid-ossp" and "pgcrypto" are part of the Supabase platform core
-- and must be preserved. They are NOT dropped by this rollback.
